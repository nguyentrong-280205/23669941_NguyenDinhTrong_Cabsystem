'use strict';

// Copy only the input that a business action needs; never pass Express req/res.
function toCommand(req) {
  return {
    params: req.params,
    query: req.query,
    body: req.body,
    user: req.user,
    actor: req.actor,
    caller: req.caller,
    headers: req.headers,
    rawBody: req.rawBody,
  };
}
function respond(res, operation, result) {
  const status =
    result?.httpStatus ||
    Number(Object.keys(operation.operation.responses).find((x) => /^2\d\d$/.test(x))) ||
    200;
  const body = result?.body === undefined ? result : result.body;
  operation.response(status, body);
  return res.status(status).json(body);
}
module.exports = { toCommand, respond };
