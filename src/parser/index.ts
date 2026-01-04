import { CSVParsedData, ParsedFile } from './types';
// This is how package documentation imports the package
// eslint-disable-next-line import/default
import Papa from 'papaparse';

export async function parseCsv({ file }: { file: File }): Promise<ParsedFile> {
  const startTime = performance.now();
  console.log(
    `[PERF] Starting CSV parse - File size: ${(file.size / 1024 / 1024).toFixed(2)}MB`
  );

  return new Promise((resolve, reject) => {
    // eslint-disable-next-line import/no-named-as-default-member
    Papa.parse<CSVParsedData>(file, {
      skipEmptyLines: true,
      header: true,
      complete: (results) => {
        const duration = performance.now() - startTime;
        console.log(
          `[PERF] CSV parse completed - Rows: ${results.data.length} - Duration: ${duration.toFixed(2)}ms`
        );
        resolve(results as ParsedFile);
      },
      error: (error) => {
        console.error(
          `[PERF] CSV parse failed after ${(performance.now() - startTime).toFixed(2)}ms`
        );
        reject(error);
      },
    });
  });
}
