const rows = $input.all();

const grouped = {};
rows.forEach(row => {
  const primary = (row.json['Primary Issue'] || '').trim();
  const sub     = (row.json['Sub Issue'] || '').trim();
  if (!primary || !sub) return;
  if (!grouped[primary]) grouped[primary] = [];
  grouped[primary].push(sub);
});

const lines = Object.keys(grouped).map(primary => {
  const subLines = grouped[primary].map(sub =>
    `  "Sub Issue": "${sub}"`
  );
  return `"Primary Issue": "${primary}"\n${subLines.join('\n')}`;
});

const output = "APPROVED TAXONOMY\n"
  + "After locking issue_primary from the Policy Area Mapping, find the matching \"Primary Issue\" section below.\n"
  + "Select the \"Sub Issue\" whose name best matches the bill title and subject tags.\n\n"
  + lines.join('\n\n');

return [{ json: { approved_taxonomy: output } }];