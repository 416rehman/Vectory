/** "1 device", "3 devices", "1,284 batches": a count with its noun. */
export const countLabel = (count: number, word: string, many = `${word}s`) =>
  `${count.toLocaleString()} ${count === 1 ? word : many}`;
