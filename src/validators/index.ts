import { hasData, eachWithObject } from '../utils/functional';
import {
  ImporterValidationError,
  ImporterValidatorDefinition,
  RequiredValidatorDefinition,
} from './types';
import { SheetColumnDefinition, SheetDefinition, SheetState } from '../types';
import { Validator } from './validator_definitions/base';
import { buildValidatorFromDefinition } from './validator_definitions';
import { extractReferenceColumnPossibleValues } from '../sheet/utils';

export function fieldIsRequired(
  columnDefinition: SheetColumnDefinition,
  { skipConditionCheck }: { skipConditionCheck?: boolean } = {}
) {
  if (columnDefinition.validators && columnDefinition.validators.length > 0) {
    const isRequired = columnDefinition.validators.find(
      (v) => v.validate === 'required'
    );
    return (
      isRequired != null &&
      (skipConditionCheck
        ? true
        : (isRequired as RequiredValidatorDefinition).when == null)
    );
  }
  return false;
}

function automaticFieldValidators(
  columnDefinition: SheetColumnDefinition,
  allData: SheetState[]
): ImporterValidatorDefinition[] {
  const result: ImporterValidatorDefinition[] = [];

  if (columnDefinition.type === 'enum') {
    result.push({
      values: columnDefinition.typeArguments.values.map((v) => v.value),
      validate: 'includes',
    });
  }

  if (columnDefinition.type === 'reference') {
    const referenceData = extractReferenceColumnPossibleValues(
      columnDefinition,
      allData
    );

    result.push({
      values: referenceData,
      validate: 'includes',
    });
  }

  return result;
}

async function validateSheet(
  sheetDefinition: SheetDefinition,
  sheetData: SheetState,
  allData: SheetState[]
) {
  const validationErrors: ImporterValidationError[] = [];
  const validationPromises: Promise<void>[] = [];

  const validatorsByColumnId = eachWithObject<
    SheetColumnDefinition,
    Validator[]
  >(sheetDefinition.columns, (columnDefinition, obj) => {
    obj[columnDefinition.id] = [];

    const validatorDefinitions = [
      ...(columnDefinition.validators ?? []),
      ...automaticFieldValidators(columnDefinition, allData),
    ];

    validatorDefinitions.forEach((validatorDefinition) => {
      obj[columnDefinition.id].push(
        buildValidatorFromDefinition(validatorDefinition)
      );
    });
  });

  sheetDefinition.columns.forEach((columnDefinition) => {
    sheetData.rows.forEach((row, rowIndex) => {
      if (!hasData(row)) {
        return;
      }

      if (
        !(columnDefinition.id in row) &&
        !fieldIsRequired(columnDefinition, { skipConditionCheck: true })
      ) {
        return;
      }

      const value = row[columnDefinition.id];
      const validators = validatorsByColumnId[columnDefinition.id];

      validators.forEach((v) => {
        const promise = Promise.resolve(v.isValid(value, row)).then(
          (result) => {
            if (result != null) {
              validationErrors.push({
                sheetId: sheetDefinition.id,
                columnId: columnDefinition.id,
                rowIndex,
                message: result,
              });
            }
          }
        );
        validationPromises.push(promise);
      });
    });
  });

  await Promise.all(validationPromises);
  return validationErrors;
}

export async function applyValidations(
  sheetDefinitions: SheetDefinition[],
  sheetStates: SheetState[]
) {
  const startTime = performance.now();
  const totalRows = sheetStates.reduce((sum, sheet) => sum + sheet.rows.length, 0);
  console.log(
    `[PERF] Starting validation - Sheets: ${sheetDefinitions.length} - Total rows: ${totalRows}`
  );

  const promises = sheetDefinitions.map(async (sheetDefinition) => {
    const sheetData = sheetStates.find(
      (state) => state.sheetId === sheetDefinition.id
    );

    if (sheetData) {
      const sheetStart = performance.now();
      const errors = await validateSheet(
        sheetDefinition,
        sheetData,
        sheetStates
      );
      console.log(
        `[PERF] Validated sheet "${sheetDefinition.id}" - Rows: ${sheetData.rows.length} - Errors: ${errors.length} - Duration: ${(performance.now() - sheetStart).toFixed(2)}ms`
      );
      return errors;
    }
    return [];
  });

  const allErrors = await Promise.all(promises);
  const duration = performance.now() - startTime;
  const totalErrors = allErrors.flat().length;
  console.log(
    `[PERF] Validation completed - Total errors: ${totalErrors} - Duration: ${duration.toFixed(2)}ms`
  );
  return allErrors.flat();
}

async function validateSpecificRows(
  sheetDefinition: SheetDefinition,
  sheetData: SheetState,
  allData: SheetState[],
  rowIndices: Set<number>
) {
  const validationErrors: ImporterValidationError[] = [];
  const validationPromises: Promise<void>[] = [];

  const validatorsByColumnId = eachWithObject<
    SheetColumnDefinition,
    Validator[]
  >(sheetDefinition.columns, (columnDefinition, obj) => {
    obj[columnDefinition.id] = [];

    const validatorDefinitions = [
      ...(columnDefinition.validators ?? []),
      ...automaticFieldValidators(columnDefinition, allData),
    ];

    validatorDefinitions.forEach((validatorDefinition) => {
      obj[columnDefinition.id].push(
        buildValidatorFromDefinition(validatorDefinition)
      );
    });
  });

  sheetDefinition.columns.forEach((columnDefinition) => {
    sheetData.rows.forEach((row, rowIndex) => {
      // Only validate rows in the rowIndices set
      if (!rowIndices.has(rowIndex)) {
        return;
      }

      if (!hasData(row)) {
        return;
      }

      if (
        !(columnDefinition.id in row) &&
        !fieldIsRequired(columnDefinition, { skipConditionCheck: true })
      ) {
        return;
      }

      const value = row[columnDefinition.id];
      const validators = validatorsByColumnId[columnDefinition.id];

      validators.forEach((v) => {
        const promise = Promise.resolve(v.isValid(value, row)).then(
          (result) => {
            if (result != null) {
              validationErrors.push({
                sheetId: sheetDefinition.id,
                columnId: columnDefinition.id,
                rowIndex,
                message: result,
              });
            }
          }
        );
        validationPromises.push(promise);
      });
    });
  });

  await Promise.all(validationPromises);
  return validationErrors;
}

export async function applyValidationsToSpecificRows(
  sheetDefinitions: SheetDefinition[],
  sheetStates: SheetState[],
  existingErrors: ImporterValidationError[],
  dirtyRows: Map<string, Set<number>>
) {
  const startTime = performance.now();
  const totalDirtyRows = Array.from(dirtyRows.values()).reduce(
    (sum, set) => sum + set.size,
    0
  );
  console.log(
    `[PERF] Starting incremental validation - Dirty rows: ${totalDirtyRows}`
  );

  const promises = sheetDefinitions.map(async (sheetDefinition) => {
    const sheetData = sheetStates.find(
      (state) => state.sheetId === sheetDefinition.id
    );

    const dirtyRowIndices = dirtyRows.get(sheetDefinition.id);

    if (sheetData && dirtyRowIndices && dirtyRowIndices.size > 0) {
      const sheetStart = performance.now();
      const errors = await validateSpecificRows(
        sheetDefinition,
        sheetData,
        sheetStates,
        dirtyRowIndices
      );
      console.log(
        `[PERF] Validated sheet "${sheetDefinition.id}" - Dirty rows: ${dirtyRowIndices.size} - Errors: ${errors.length} - Duration: ${(performance.now() - sheetStart).toFixed(2)}ms`
      );
      return errors;
    }
    return [];
  });

  const newErrors = await Promise.all(promises);

  // Remove old errors for dirty rows and add new errors
  const dirtyRowKeys = new Set<string>();
  dirtyRows.forEach((rowIndices, sheetId) => {
    rowIndices.forEach((rowIndex) => {
      dirtyRowKeys.add(`${sheetId}-${rowIndex}`);
    });
  });

  const filteredExistingErrors = existingErrors.filter(
    (error) => !dirtyRowKeys.has(`${error.sheetId}-${error.rowIndex}`)
  );

  const allErrors = [...filteredExistingErrors, ...newErrors.flat()];

  const duration = performance.now() - startTime;
  console.log(
    `[PERF] Incremental validation completed - Total errors: ${allErrors.length} - Duration: ${duration.toFixed(2)}ms`
  );
  return allErrors;
}
