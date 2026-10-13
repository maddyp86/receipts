const rows = $input.all();

const lines = rows
  .filter(row => row.json['Policy Area'] && row.json['Primary Issue'])
  .map(row => {
    const pa      = row.json['Policy Area'].trim();
    const primary = row.json['Primary Issue'].trim();
    return `"Policy Area": "${pa}" → "Primary Issue": "${primary}"`;
  });

const output = "POLICY AREA MAPPING\n"
  + "Find the row where Policy Area matches the bill's Policy Area (raw) value (case-insensitive).\n"
  + "Copy the mapped Primary Issue exactly as written — this is your LOCKED issue_primary.\n\n"
  + lines.join('\n');

return [{ json: { policy_area_taxonomy: output } }];