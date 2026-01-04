import { Dispatch } from 'preact/hooks';
import {
  ColumnMapping,
  ImporterAction,
  ImporterState,
  PersistenceConfig,
  SheetDefinition,
  StateBuilderImporterDefinition,
  RemoveRowsPayload,
  CellChangedPayload,
} from '../types';
import { getIndexedDBState, setIndexedDBState } from './storage';
import { buildSuggestedHeaderMappings } from '@/mapper/utils';
import { convertCsvFile } from '@/uploader/utils';
import { parseCsv } from '@/parser';
import { reducer } from './reducer';
import { applyValidations, applyValidationsToSpecificRows } from '../validators';
import { generateValidationRunId } from '@/validators/utils';
import { NUMBER_OF_EMPTY_ROWS_FOR_MANUAL_DATA_INPUT } from '@/constants';
import { getMappedData } from '@/mapper';

export async function buildState(
  sheetDefinitions: SheetDefinition[],
  persistenceConfig: PersistenceConfig
): Promise<ImporterState> {
  const defaultState = buildInitialState(sheetDefinitions);
  try {
    if (!persistenceConfig.enabled) return defaultState;

    return await buildStateWithIndexedDB(sheetDefinitions, persistenceConfig);
  } catch (_error) {
    return defaultState;
  }
}

export function buildInitialState(
  sheetDefinitions: SheetDefinition[]
): ImporterState {
  return {
    sheetDefinitions,
    currentSheetId: sheetDefinitions[0].id,
    mode: 'upload',
    validationErrors: [],
    validationInProgress: false,
    sheetData: sheetDefinitions.map((sheet) => ({
      sheetId: sheet.id,
      rows: [],
    })),
    importProgress: 0,
  };
}

async function buildStateWithIndexedDB(
  sheetDefinitions: SheetDefinition[],
  persistenceConfig: PersistenceConfig
): Promise<ImporterState> {
  const state = await getIndexedDBState(
    sheetDefinitions,
    persistenceConfig.customKey
  );

  if (state != null) {
    return state;
  }

  const newState = buildInitialState(sheetDefinitions);
  setIndexedDBState(newState, persistenceConfig.customKey);
  return newState;
}

class StateBuilder {
  private initialState: ImporterState;

  private importerDefinition: StateBuilderImporterDefinition;

  protected buildSteps: ImporterAction[];

  constructor(
    importerDefinition: StateBuilderImporterDefinition,
    initialState?: ImporterState
  ) {
    this.importerDefinition = importerDefinition;
    this.initialState =
      initialState ?? buildInitialState(importerDefinition.sheets);
    this.buildSteps = [];
  }

  public async getState(): Promise<ImporterState> {
    let state = this.initialState;

    this.buildSteps.forEach((step) => {
      state = reducer(state, step);
    });

    // Use incremental validation if dirty rows are tracked and there are some dirty rows
    const hasDirtyRows =
      state.dirtyRows &&
      Array.from(state.dirtyRows.values()).some((set) => set.size > 0);

    const validationErrors = hasDirtyRows
      ? await applyValidationsToSpecificRows(
          this.importerDefinition.sheets,
          state.sheetData,
          state.validationErrors,
          state.dirtyRows!
        ).catch(() => state.validationErrors)
      : await applyValidations(
          this.importerDefinition.sheets,
          state.sheetData
        ).catch(() => state.validationErrors);

    return { ...state, validationErrors };
  }

  public async uploadFile(file: File) {
    const csvFile = await convertCsvFile(
      file,
      this.importerDefinition.customFileLoaders
    );

    const newParsed = await parseCsv({ file: csvFile });

    const csvHeaders = newParsed.meta.fields!;

    const suggestedMappings =
      this.importerDefinition.customSuggestedMapper != null
        ? await this.importerDefinition.customSuggestedMapper(
            this.importerDefinition.sheets,
            csvHeaders
          )
        : buildSuggestedHeaderMappings(
            this.importerDefinition.sheets,
            csvHeaders
          );

    this.buildSteps.push({
      type: 'FILE_PARSED',
      payload: { parsed: newParsed, rowFile: file },
    });

    this.buildSteps.push({
      type: 'COLUMN_MAPPING_CHANGED',
      payload: {
        mappings: suggestedMappings,
      },
    });
  }

  public setEnterDataManually(amountOfEmptyRowsToAdd?: number) {
    this.buildSteps.push({
      type: 'ENTER_DATA_MANUALLY',
      payload: {
        amountOfEmptyRowsToAdd:
          amountOfEmptyRowsToAdd ?? NUMBER_OF_EMPTY_ROWS_FOR_MANUAL_DATA_INPUT,
      },
    });
  }

  public setMappings(mappings: ColumnMapping[]) {
    this.buildSteps.push({
      type: 'COLUMN_MAPPING_CHANGED',
      payload: { mappings },
    });
  }

  public async confirmMappings() {
    const stateSoFar = await this.getState();

    const mappedData = getMappedData(
      this.importerDefinition.sheets,
      stateSoFar.columnMappings ?? [],
      stateSoFar.parsedFile!
    );

    const newMappedData =
      this.importerDefinition.onDataColumnsMapped != null
        ? await this.importerDefinition.onDataColumnsMapped(mappedData)
        : mappedData;

    this.buildSteps.push({
      type: 'DATA_MAPPED',
      payload: { mappedData: newMappedData },
    });
  }

  public changeCell(payload: CellChangedPayload) {
    this.buildSteps.push({ type: 'CELL_CHANGED', payload });
  }

  public removeRows(payload: RemoveRowsPayload) {
    this.buildSteps.push({ type: 'REMOVE_ROWS', payload });
  }
}

export class OuterStateBuilder extends StateBuilder {
  // eslint-disable-next-line @typescript-eslint/no-useless-constructor
  constructor(importerDefinition: StateBuilderImporterDefinition) {
    super(importerDefinition);
  }
}

export class InnerStateBuilder extends StateBuilder {
  private validationTimeoutId: NodeJS.Timeout | null = null;
  private static readonly VALIDATION_DEBOUNCE_MS = 400;

  // eslint-disable-next-line @typescript-eslint/no-useless-constructor
  constructor(
    importerDefinition: StateBuilderImporterDefinition,
    initialState: ImporterState
  ) {
    super(importerDefinition, initialState);
  }

  private static readonly actionTypesThatRequireValidation: ReadonlySet<
    ImporterAction['type']
  > = new Set<ImporterAction['type']>([
    'DATA_MAPPED',
    'CELL_CHANGED',
    'REMOVE_ROWS',
  ]);

  private async runValidation(dispatch: Dispatch<ImporterAction>, runId: string) {
    console.log(`[PERF] Running debounced validation - Run ID: ${runId}`);
    const finalState = await this.getState();
    dispatch({
      type: 'VALIDATION_COMPLETED',
      payload: { errors: finalState.validationErrors, runId },
    });
  }

  public async dispatchChange(dispatch: Dispatch<ImporterAction>) {
    const shouldValidate = this.buildSteps.some((step) =>
      InnerStateBuilder.actionTypesThatRequireValidation.has(step.type)
    );

    const runId = generateValidationRunId();

    if (shouldValidate) {
      dispatch({ type: 'VALIDATION_STARTED', payload: { runId } });
    }

    this.buildSteps.forEach((step) => {
      dispatch(step);
    });

    if (shouldValidate) {
      // Clear any pending validation
      if (this.validationTimeoutId) {
        clearTimeout(this.validationTimeoutId);
      }

      // Debounce validation - only validate after user stops typing
      this.validationTimeoutId = setTimeout(() => {
        this.runValidation(dispatch, runId);
        this.validationTimeoutId = null;
      }, InnerStateBuilder.VALIDATION_DEBOUNCE_MS);
    }
  }
}
