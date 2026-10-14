import assert from "node:assert/strict";
import { test } from "node:test";
import { refusal, withScheme } from "../server/urlPolicy.ts";

test("public http(s) sites are allowed", () => {
  for (const url of ["https://example.com", "example.com/path?q=1", "http://news.ycombinator.com", "about:blank", "8.8.8.8"]) {
    assert.equal(refusal(url), null, url);
  }
});

test("other schemes are refused", () => {
  for (const url of ["file:///etc/passwd", "javascript:alert(1)", "chrome://settings", "data:text/html,hi", "ftp://x.org"]) {
    assert.match(refusal(url) ?? "", /Only http and https/, url);
  }
});

test("this machine and private networks are refused", () => {
  for (const url of [
    "http://localhost:4477", "http://127.0.0.1", "http://0x7f.1", "http://2130706433", "http://[::1]/",
    "http://169.254.169.254/latest/meta-data", "http://192.168.1.1", "http://10.0.0.5", "http://172.20.1.1",
    "http://printer.local", "http://router", "http://[::ffff:127.0.0.1]", "http://foo.localhost",
  ]) {
    assert.match(refusal(url) ?? "", /private network/, url);
  }
});

test("adds https:// when the scheme is missing", () => {
  assert.equal(withScheme("example.com"), "https://example.com");
  assert.equal(withScheme("http://example.com"), "http://example.com");
});
