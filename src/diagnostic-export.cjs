'use strict';
const active = new WeakSet();
async function exportDiagnosticReport(log, dialog, parent, getHealth) {
  if (active.has(log)) throw new Error('A diagnostic report is already open.');
  active.add(log);
  let preview;
  const show = (method, options) =>
    parent ? dialog[method](parent, options) : dialog[method](options);
  try {
    preview = log.preview({ health: getHealth?.() });
    const detail =
      preview.files
        .map((file) => file.name + ': ' + file.records + ' metadata records')
        .join('\n') +
      '\n\nIncludes timings, delivery phases, error categories, versions and anonymous correlation IDs.' +
      '\nExcludes prompts, answers, drafts, images, credentials and private paths. Nothing is uploaded.';
    const review = await show('showMessageBox', {
      type: 'info',
      title: 'Diagnostic report',
      message: 'Review the local report before saving',
      detail,
      buttons: ['Cancel', 'Choose save location'],
      defaultId: 0,
      cancelId: 0,
    });
    if (review.response !== 1) return { cancelled: true };
    const selected = await show('showSaveDialog', {
      title: 'Save diagnostic report',
      defaultPath: 'Hyphen-diagnostics.json',
      filters: [{ name: 'Diagnostic report', extensions: ['json'] }],
    });
    if (selected.canceled || !selected.filePath) return { cancelled: true };
    return log.export(preview.previewId, selected.filePath);
  } finally {
    if (log.prepared?.previewId === preview?.previewId) log.prepared = null;
    active.delete(log);
  }
}
module.exports = { exportDiagnosticReport };
