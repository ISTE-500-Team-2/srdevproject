/** Rows per page for offset-paginated lists; queries fetch one extra row to detect a next page. */
export const PAGE_SIZE = 50;

export function page<T>(rows: T[], offset: number) {
  return {
    items: rows.slice(0, PAGE_SIZE),
    nextOffset: rows.length > PAGE_SIZE ? offset + PAGE_SIZE : null,
  };
}
