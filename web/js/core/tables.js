// Copies each column heading onto the cells below it (data-label) so CSS can show tables as stacked cards on
// phones. Rows are rendered by page scripts after load, so a MutationObserver keeps the labels current.
function labelTable(table) {
  const heads = [...table.querySelectorAll('thead th')].map(th => th.textContent.trim());
  if (!heads.length) return;
  for (const row of table.querySelectorAll('tbody tr')) {
    let col = 0;
    for (const cell of row.children) {
      const span = Number(cell.getAttribute('colspan') ?? 1);
      if (span === 1 && heads[col] && cell.dataset.label !== heads[col]) cell.dataset.label = heads[col];
      col += span;
    }
  }
}

export function initTableLabels() {
  let queued = false;
  const run = () => {
    queued = false;
    document.querySelectorAll('table.zx-table').forEach(labelTable);
  };
  run();
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    queueMicrotask(run);
  }).observe(document.body, { childList: true, subtree: true });
}
