const rows = $input.all();

const lines = rows
  .filter(row => row.json['Legislative Subject'] && row.json['Primary Issue'] && row.json['Sub Issue'])
  .map(row => {
    const subject = row.json['Legislative Subject'].trim();
    const primary = row.json['Primary Issue'].trim();
    const sub     = row.json['Sub Issue'].trim();
    return `"Subject Tag": "${subject}" → "Primary Issue": "${primary}" | "Sub Issue": "${sub}"`;
  });

const output = "SUBJECT AREA MAPPING\n"
  + "Scan the bill's Subject Tags (raw) against this table (case-insensitive).\n"
  + "If any Subject Tag matches a row, use that row's Primary Issue and Sub Issue.\n"
  + "A Subject Tag match overrides the Reference 1 Policy Area mapping.\n"
  + "If multiple Subject Tags match, use the most specific match (fewest competing rows).\n"
  + "If no Subject Tags match, skip this reference and proceed with Reference 1 mapping.\n\n"
  + lines.join('\n');

return [{ json: { subject_area_taxonomy: output } }];