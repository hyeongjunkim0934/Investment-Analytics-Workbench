/* Run the production exact-return solver; independent answers live in Python. */
'use strict';
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../dashboard/port-constraints.js'), 'utf8');
const api = vm.runInNewContext(source + '\n({portConstraintSpec, portConstrainedModel})');
const cases = JSON.parse(fs.readFileSync(0, 'utf8'));
const results = cases.map((c) => {
  const before = JSON.stringify(c);
  const spec = api.portConstraintSpec({ assets: c.assets }, c.constraints || {});
  const model = api.portConstrainedModel(c.C, c.mu, c.months || 60, spec);
  return { valid: !!model, spec, vertices: model?.vertices,
    gmv: model?.solve(Infinity), points: c.targets.map((t) => model?.atReturn(t) || null),
    unchanged: JSON.stringify(c) === before };
});
process.stdout.write(JSON.stringify(results));
