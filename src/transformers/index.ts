import { isEmptyCell } from '@/utils';
import {
  ImporterOutputFieldType,
  SheetColumnDefinition,
  SheetDefinition,
  SheetState,
} from '../types';
import { eachWithObject, hasData } from '../utils/functional';
import { buildTransformerFromDefinition } from './transformer_definitions';
import { Transformer } from './transformer_definitions/base';

function buildPipelineByColumnId(
  sheetDefinition: SheetDefinition
): Record<string, Pipeline> {
  return eachWithObject<SheetColumnDefinition, Pipeline>(
    sheetDefinition.columns,
    (columnDefinition, obj) => {
      obj[columnDefinition.id] = new Pipeline();
      if (!columnDefinition.transformers) return;
      columnDefinition.transformers.forEach((transformerDefinition) => {
        obj[columnDefinition.id].push(
          buildTransformerFromDefinition(transformerDefinition)
        );
      });
    }
  );
}

function transformRow(
  row: Record<string, ImporterOutputFieldType>,
  pipelineByColumnId: Record<string, Pipeline>,
  sheetDefinition: SheetDefinition
): Record<string, ImporterOutputFieldType> {
  if (!hasData(row)) {
    return row;
  }

  const transformedRow = { ...row };

  sheetDefinition.columns.forEach((columnDefinition) => {
    const columnId = columnDefinition.id;
    const pipeline = pipelineByColumnId[columnId];
    const cellValue = transformedRow[columnId];

    if (!isEmptyCell(cellValue)) {
      transformedRow[columnId] = pipeline.transform(cellValue);
    }
  });

  return transformedRow;
}

function transformSheet(
  sheetDefinition: SheetDefinition,
  sheetData: SheetState
) {
  const pipelineByColumnId = buildPipelineByColumnId(sheetDefinition);

  sheetDefinition.columns.forEach((columnDefinition) => {
    const columnId = columnDefinition.id;
    const pipeline = pipelineByColumnId[columnId];

    sheetData.rows.forEach((row) => {
      if (!hasData(row)) {
        return;
      }

      const cellValue = row[columnId];

      if (!isEmptyCell(cellValue)) {
        row[columnId] = pipeline.transform(cellValue);
      }
    });
  });

  return sheetData.rows;
}

export function applyTransformations(
  sheetDefinitions: SheetDefinition[],
  sheetStates: SheetState[]
) {
  const startTime = performance.now();
  const totalRows = sheetStates.reduce((sum, sheet) => sum + sheet.rows.length, 0);
  console.log(
    `[PERF] Starting transformations - Sheets: ${sheetDefinitions.length} - Total rows: ${totalRows}`
  );

  const newSheetStates: SheetState[] = [];

  sheetDefinitions.forEach((sheetDefinition) => {
    const sheetData = sheetStates.find(
      (state) => state.sheetId === sheetDefinition.id
    );

    if (sheetData) {
      const sheetStart = performance.now();
      const newRows = transformSheet(sheetDefinition, sheetData);
      console.log(
        `[PERF] Transformed sheet "${sheetDefinition.id}" - Rows: ${sheetData.rows.length} - Duration: ${(performance.now() - sheetStart).toFixed(2)}ms`
      );

      newSheetStates.push({ sheetId: sheetDefinition.id, rows: newRows });
    }
  });

  const duration = performance.now() - startTime;
  console.log(`[PERF] Transformations completed - Duration: ${duration.toFixed(2)}ms`);
  return newSheetStates;
}

export function applyTransformationsToSingleRow(
  sheetDefinitions: SheetDefinition[],
  sheetStates: SheetState[],
  targetSheetId: string,
  targetRowIndex: number
): SheetState[] {
  const startTime = performance.now();
  console.log(
    `[PERF] Starting single-row transformation - Sheet: ${targetSheetId} - Row: ${targetRowIndex}`
  );

  const newSheetStates: SheetState[] = sheetStates.map((sheetState) => {
    if (sheetState.sheetId !== targetSheetId) {
      return sheetState;
    }

    const sheetDefinition = sheetDefinitions.find(
      (def) => def.id === targetSheetId
    );

    if (!sheetDefinition) {
      return sheetState;
    }

    const pipelineByColumnId = buildPipelineByColumnId(sheetDefinition);
    const newRows = [...sheetState.rows];
    const targetRow = newRows[targetRowIndex];

    if (targetRow) {
      newRows[targetRowIndex] = transformRow(
        targetRow,
        pipelineByColumnId,
        sheetDefinition
      );
    }

    return { ...sheetState, rows: newRows };
  });

  const duration = performance.now() - startTime;
  console.log(
    `[PERF] Single-row transformation completed - Duration: ${duration.toFixed(2)}ms`
  );
  return newSheetStates;
}

export class Pipeline {
  steps: Transformer[];

  // Series of transformations
  constructor(steps = []) {
    this.steps = steps;
  }

  push(step: Transformer) {
    this.steps.push(step);
  }

  transform(value: ImporterOutputFieldType) {
    let current = value;
    this.steps.forEach((step) => {
      current = step.transform(current);
    });
    return current;
  }
}
