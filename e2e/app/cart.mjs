/** A tiny in-memory domain for the dogfood suite to exercise, so the Gherkin
 * reads like a real BDD suite rather than "Given a step that passes". */
export function createCart() {
  const items = [];
  return {
    add(name, qty, unitPrice) {
      items.push({ name, qty, unitPrice });
    },
    total() {
      return items.reduce((sum, i) => sum + i.qty * i.unitPrice, 0);
    },
  };
}
