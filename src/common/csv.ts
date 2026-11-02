const QUOTE = '"';

export type CsvRecord = string[];

const detectDelimiter = (header: string): string => {
  const counts = new Map<string, number>();
  for (const candidate of [',', ';', '\t']) {
    let count = 0;
    let quoted = false;
    for (let i = 0; i < header.length; i += 1) {
      const char = header[i];
      if (char === QUOTE) quoted = !quoted;
      else if (!quoted && char === candidate) count += 1;
    }
    counts.set(candidate, count);
  }
  let best = ',';
  let bestCount = -1;
  for (const [candidate, count] of counts) {
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return best;
};

export const parseCsv = (input: string): CsvRecord[] => {
  const text = input.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const firstBreak = text.indexOf('\n');
  const delimiter = detectDelimiter(firstBreak === -1 ? text : text.slice(0, firstBreak));

  const rows: CsvRecord[] = [];
  let row: CsvRecord = [];
  let field = '';
  let quoted = false;

  const pushField = (): void => {
    row.push(field);
    field = '';
  };
  const pushRow = (): void => {
    pushField();
    const onlyEmpty = row.length === 1 && row[0] === '';
    if (!onlyEmpty) rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === QUOTE) {
        if (text[i + 1] === QUOTE) {
          field += QUOTE;
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === QUOTE) {
      quoted = true;
      continue;
    }
    if (char === delimiter) {
      pushField();
      continue;
    }
    if (char === '\n') {
      pushRow();
      continue;
    }
    field += char;
  }
  if (field !== '' || row.length > 0) pushRow();
  return rows;
};

const needsQuotes = (value: string): boolean => /[",;\t\n\r]/.test(value) || /^\s|\s$/.test(value);

export const toCsvValue = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return needsQuotes(text) ? `${QUOTE}${text.split(QUOTE).join(`${QUOTE}${QUOTE}`)}${QUOTE}` : text;
};

export const toCsv = (rows: Array<Array<unknown>>): string =>
  `${rows.map((row) => row.map(toCsvValue).join(',')).join('\r\n')}\r\n`;

export const parseCsvRecords = (input: string): Array<Record<string, string>> => {
  const rows = parseCsv(input);
  if (rows.length === 0) return [];
  const header = rows[0].map((cell) => cell.trim().toLowerCase());
  return rows.slice(1).map((row) => {
    const record: Record<string, string> = {};
    header.forEach((key, index) => {
      if (key) record[key] = (row[index] ?? '').trim();
    });
    return record;
  });
};
