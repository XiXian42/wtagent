// Passed directly to Locator.evaluateAll: keep this function self-contained.
// Read connected nodes so innerText keeps layout whitespace and omits hidden
// descendants. Cloning first changes innerText into textContent-like output.
export function readRenderedBlocks(elements) {
  const roots = elements.filter((element) => (
    !elements.some((other) => other !== element && other.contains(element))
  ));
  return roots.filter((element) => element.getClientRects().length > 0)
    .map((element) => element.innerText)
    .join("\n");
}
