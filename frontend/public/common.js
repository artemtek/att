async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text };
  }
  if (!res.ok) {
    throw new Error((data && data.error) || res.statusText);
  }
  return data;
}

function qs(name) {
  return new URLSearchParams(location.search).get(name);
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

function nav() {
  document.body.insertAdjacentHTML(
    "afterbegin",
    '<p><a href="/">home</a> | <a href="/users.html">users</a> | <a href="/tasks.html">task defs</a> | <a href="/workflows.html">workflow defs</a></p><hr>'
  );
}

function showError(err) {
  const el = document.getElementById("error");
  const msg = err && err.message ? err.message : String(err);
  if (el) el.textContent = msg;
  else alert(msg);
}

function formValues(form) {
  return Object.fromEntries(new FormData(form).entries());
}

document.addEventListener("DOMContentLoaded", nav);
