'use strict';
const path = require('node:path');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');
const { demand } = require('./core');
function normalize(value, input = false) {
  if (Array.isArray(value)) return value.map((x) => normalize(x, input));
  if (!value || typeof value !== 'object') return value;
  const out = Object.fromEntries(
    Object.entries(value)
      .filter(
        ([k]) =>
          !['example', 'examples', 'description', 'nullable', 'writeOnly', 'readOnly'].includes(k),
      )
      .map(([k, v]) => [k, normalize(v, input)]),
  );
  if (value.nullable && out.type) out.type = [out.type, 'null'];
  if (out.exclusiveMinimum === true) {
    out.exclusiveMinimum = out.minimum;
    delete out.minimum;
  } else if (typeof out.exclusiveMinimum === 'boolean') delete out.exclusiveMinimum;
  if (out.exclusiveMaximum === true) {
    out.exclusiveMaximum = out.maximum;
    delete out.maximum;
  } else if (typeof out.exclusiveMaximum === 'boolean') delete out.exclusiveMaximum;
  if (input && out.type === 'object' && out.properties && !out.allOf)
    out.additionalProperties = false;
  if (value.nullable) return { anyOf: [out, { type: 'null' }] };
  return out;
}
function validators(document) {
  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);
  const compile = (schema, input = false) =>
    schema
      ? ajv.compile({
          ...normalize(schema, input),
          components: normalize(document.components || {}, input),
        })
      : null;
  return compile;
}
function contract(owner, file = 'openapi') {
  const document = require(
    path.resolve(__dirname, `../../docs/api_document/${owner}/${file}.json`),
  );
  const compile = validators(document);
  const operations = [];
  for (const [route, methods] of Object.entries(document.paths))
    for (const [method, operation] of Object.entries(methods)) {
      if (!['get', 'post', 'patch', 'put', 'delete'].includes(method)) continue;
      const body = compile(operation.requestBody?.content?.['application/json']?.schema, true);
      const response = Object.fromEntries(
        Object.entries(operation.responses).map(([code, r]) => [
          code,
          compile(r.content?.['application/json']?.schema),
        ]),
      );
      const params = [...(methods.parameters || []), ...(operation.parameters || [])]
        .filter((p) => p.schema)
        .map((p) => ({ ...p, validate: compile(p.schema) }));
      operations.push({
        route: route.replace(/\{([^}]+)\}/g, ':$1'),
        method,
        operation,
        validate(req) {
          if (body)
            demand(
              body(req.body),
              400,
              'VALIDATION_ERROR',
              'Request body does not match API contract',
            );
          for (const p of params) {
            let value =
              p.in === 'query'
                ? req.query[p.name]
                : p.in === 'path'
                  ? req.params[p.name]
                  : req.headers[p.name.toLowerCase()];
            demand(
              value !== undefined || !p.required,
              400,
              'VALIDATION_ERROR',
              `Missing ${p.name}`,
            );
            if (value === undefined) continue;
            if (p.schema.type === 'number' || p.schema.type === 'integer') {
              demand(
                typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value),
                400,
                'VALIDATION_ERROR',
                `Invalid ${p.name}`,
              );
              value = Number(value);
            }
            demand(p.validate(value), 400, 'VALIDATION_ERROR', `Invalid ${p.name}`);
          }
        },
        response(code, data) {
          const valid = response[code] || response.default;
          demand(
            !valid || valid(data),
            500,
            'RESPONSE_CONTRACT_ERROR',
            'Response does not match API contract',
          );
        },
      });
    }
  // Literal routes such as /api/v1/drivers/me must precede /api/v1/drivers/:id.
  return operations.sort(
    (a, b) =>
      (a.route.match(/:/g)?.length || 0) - (b.route.match(/:/g)?.length || 0) ||
      b.route.length - a.route.length,
  );
}
module.exports = { contract, normalize };
