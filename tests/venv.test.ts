import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { cacheRoot, venvDir, venvPython, getVenvPython, findPython3 } from "../src/venv.js";

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "autoillustrate-venv-"));
}

test("cacheRoot honors XDG_CACHE_HOME", () => {
  assert.equal(cacheRoot({ XDG_CACHE_HOME: "/xdg" }), "/xdg/autoillustrate");
  assert.ok(cacheRoot({}).endsWith(path.join(".cache", "autoillustrate")));
});

test("venvDir derives a stable hash from requirements content", () => {
  const dir = tmpdir();
  const reqA = path.join(dir, "a.txt");
  const reqB = path.join(dir, "b.txt");
  fs.writeFileSync(reqA, "pydantic>=2.6\n");
  fs.writeFileSync(reqB, "pydantic>=2.7\n");
  const env = { XDG_CACHE_HOME: dir };
  assert.equal(venvDir(reqA, env), venvDir(reqA, env));
  assert.notEqual(venvDir(reqA, env), venvDir(reqB, env));
  assert.match(path.basename(venvDir(reqA, env)), /^venv-[0-9a-f]{10}$/);
});

test("VENV_PY env var short-circuits bootstrap", () => {
  const py = getVenvPython({ env: { VENV_PY: "/custom/bin/python" } });
  assert.equal(py, "/custom/bin/python");
});

test("completed venv (marker + python) is reused without spawning", () => {
  const dir = tmpdir();
  const req = path.join(dir, "requirements.txt");
  fs.writeFileSync(req, "fake==1\n");
  const env = { XDG_CACHE_HOME: dir };
  const vdir = venvDir(req, env);
  const py = venvPython(vdir);
  fs.mkdirSync(path.dirname(py), { recursive: true });
  fs.writeFileSync(py, "#!/bin/sh\n");
  fs.writeFileSync(path.join(vdir, ".ok"), "");
  assert.equal(getVenvPython({ requirementsFile: req, env, quiet: true }), py);
});

test("partial venv (no marker) is wiped and rebuilt; failure leaves no dir", () => {
  const dir = tmpdir();
  const req = path.join(dir, "requirements.txt");
  fs.writeFileSync(req, "fake==1\n");
  const env = { XDG_CACHE_HOME: dir, AUTOILLUSTRATE_PYTHON: "/nonexistent-python" };
  const vdir = venvDir(req, env);
  fs.mkdirSync(vdir, { recursive: true });
  fs.writeFileSync(path.join(vdir, "leftover"), "");
  assert.throws(() => getVenvPython({ requirementsFile: req, env, quiet: true }), /python3 not found/);
  assert.ok(!fs.existsSync(path.join(vdir, "leftover")), "partial dir wiped before probe failure surfaced");
});

// Fake python3: answers the version probe, and on `-m venv <dir>` builds a
// minimal venv (bin/python that exits 0 so the pip step succeeds).
function writePythonStub(dir: string, extra = ""): string {
  const stub = path.join(dir, "python3-stub");
  fs.writeFileSync(
    stub,
    `#!/bin/sh
if [ "$1" = "-c" ]; then echo "3.12"; exit 0; fi
if [ "$2" = "venv" ]; then
  d="$3"
  mkdir -p "$d/bin"
  printf '#!/bin/sh\\nexit 0\\n' > "$d/bin/python"
  chmod +x "$d/bin/python"
${extra}
fi
exit 0
`,
  );
  fs.chmodSync(stub, 0o755);
  return stub;
}

test("bootstrap builds in tmp and renames into place atomically", () => {
  const dir = tmpdir();
  const req = path.join(dir, "requirements.txt");
  fs.writeFileSync(req, "fake==1\n");
  const env = { XDG_CACHE_HOME: dir, AUTOILLUSTRATE_PYTHON: writePythonStub(dir) };
  const vdir = venvDir(req, env);
  const py = getVenvPython({ requirementsFile: req, env, quiet: true });
  assert.equal(py, venvPython(vdir));
  assert.ok(fs.existsSync(path.join(vdir, ".ok")));
  assert.ok(!fs.existsSync(`${vdir}.tmp-${process.pid}`), "tmp build dir renamed away");
});

test("bootstrap upgrades pip before the hashed requirements install", () => {
  const dir = tmpdir();
  const req = path.join(dir, "requirements.txt");
  fs.writeFileSync(req, "fake==1\n");
  const log = path.join(dir, "venv-python.log");
  // Replace the stub venv python with one that records each invocation.
  const recorder = `  printf '#!/bin/sh\\necho "$*" >> "${log}"\\nexit 0\\n' > "$d/bin/python"`;
  const env = { XDG_CACHE_HOME: dir, AUTOILLUSTRATE_PYTHON: writePythonStub(dir, recorder) };
  getVenvPython({ requirementsFile: req, env, quiet: true });
  const calls = fs.readFileSync(log, "utf8").trim().split("\n");
  assert.deepEqual(calls, [
    "-m pip install --quiet --upgrade pip",
    `-m pip install --quiet --require-hashes -r ${req}`,
  ]);
});

test("rename loser adopts the venv a concurrent bootstrap completed first", () => {
  const dir = tmpdir();
  const req = path.join(dir, "requirements.txt");
  fs.writeFileSync(req, "fake==1\n");
  // The venv step also plants a COMPLETED venv at the final path, simulating
  // a concurrent run winning the race while our build is in flight.
  const winnerSim = `  final="\${d%.tmp-*}"
  mkdir -p "$final/bin"
  echo winner > "$final/bin/python"
  : > "$final/.ok"`;
  const env = { XDG_CACHE_HOME: dir, AUTOILLUSTRATE_PYTHON: writePythonStub(dir, winnerSim) };
  const vdir = venvDir(req, env);
  const py = getVenvPython({ requirementsFile: req, env, quiet: true });
  assert.equal(py, venvPython(vdir));
  assert.equal(fs.readFileSync(py, "utf8"), "winner\n", "loser must adopt the winner's venv");
  assert.ok(!fs.existsSync(`${vdir}.tmp-${process.pid}`), "loser's tmp build removed");
});

test("stale tmp dirs from dead bootstraps are swept", () => {
  const dir = tmpdir();
  const req = path.join(dir, "requirements.txt");
  fs.writeFileSync(req, "fake==1\n");
  const env = { XDG_CACHE_HOME: dir, AUTOILLUSTRATE_PYTHON: writePythonStub(dir) };
  const vdir = venvDir(req, env);
  const stale = `${vdir}.tmp-999999999`;
  fs.mkdirSync(stale, { recursive: true });
  fs.writeFileSync(path.join(stale, "leftover"), "");
  getVenvPython({ requirementsFile: req, env, quiet: true });
  assert.ok(!fs.existsSync(stale), "dead-pid tmp dir swept");
});

test("findPython3 rejects missing interpreter", () => {
  assert.throws(() => findPython3({ AUTOILLUSTRATE_PYTHON: "/definitely/not/python" }), /python3 not found/);
});

test("findPython3 finds a suitable interpreter on this machine", (t) => {
  let py: string;
  try {
    py = findPython3({});
  } catch {
    t.skip("no python >= 3.10 on this machine");
    return;
  }
  assert.match(py, /^python3/);
});
