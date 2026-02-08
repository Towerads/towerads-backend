export function ok(res, body = {}) {
  return res.json({ success: true, ...body });
}

export function fail(res, error = "No ad available", code = 200) {
  return res.status(code).json({ success: false, error });
}
