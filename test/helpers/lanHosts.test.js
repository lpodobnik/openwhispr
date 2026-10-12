const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createLanHostVerifier,
  hostnameOf,
  VERIFIED_TTL_MS,
} = require("../../src/helpers/lanHosts");

const fakeDns = (table) => {
  const calls = [];
  const lookup = async (hostname) => {
    calls.push(hostname);
    if (!(hostname in table)) {
      const error = new Error("ENOTFOUND");
      error.code = "ENOTFOUND";
      throw error;
    }
    return table[hostname].map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  };
  return { lookup, calls };
};

test("a DNS name that resolves only to private addresses is verified", async () => {
  const { lookup } = fakeDns({ "sandcrawler.lan.croz.net": ["10.0.0.82"] });
  const verifier = createLanHostVerifier({ lookup });

  const hosts = await verifier.verifyLanHosts([
    "http://sandcrawler.lan.croz.net:8000/v1/audio/transcriptions",
  ]);
  assert.deepEqual(hosts, ["sandcrawler.lan.croz.net"]);
});

test("a name with any public address, or none, is not verified", async () => {
  const { lookup } = fakeDns({
    "mixed.example.com": ["10.0.0.5", "93.184.216.34"],
    "public.example.com": ["93.184.216.34"],
    "empty.example.com": [],
  });
  const verifier = createLanHostVerifier({ lookup });

  const hosts = await verifier.verifyLanHosts([
    "http://mixed.example.com",
    "http://public.example.com",
    "http://empty.example.com",
    "http://missing.example.com",
  ]);
  assert.deepEqual(hosts, []);
});

test("IPv6 unique-local and IPv4-mapped private addresses count as private", async () => {
  const { lookup } = fakeDns({
    "v6.lan.example.com": ["fd12:3456::1"],
    "mapped.lan.example.com": ["::ffff:192.168.1.20"],
    "mapped-public.example.com": ["::ffff:8.8.8.8"],
  });
  const verifier = createLanHostVerifier({ lookup });

  const hosts = await verifier.verifyLanHosts([
    "http://v6.lan.example.com",
    "http://mapped.lan.example.com",
    "http://mapped-public.example.com",
  ]);
  assert.deepEqual(hosts.sort(), ["mapped.lan.example.com", "v6.lan.example.com"]);
});

test("literals and names already private by name are never looked up", async () => {
  const { lookup, calls } = fakeDns({});
  const verifier = createLanHostVerifier({ lookup });

  await verifier.verifyLanHosts([
    "http://10.0.0.82:8000",
    "http://[fd00::1]:8000",
    "http://localhost:8178",
    "http://nas.local",
    "http://box.tail1234.ts.net",
    "http://singlelabel:8000",
    "",
    "not a url at all ::",
  ]);
  assert.deepEqual(calls, []);
});

test("a host that stops resolving privately loses its verification", async () => {
  const table = { "gpu.lan.example.com": ["10.0.0.9"] };
  const { lookup } = fakeDns(table);
  const verifier = createLanHostVerifier({ lookup });

  assert.deepEqual(await verifier.verifyLanHosts(["http://gpu.lan.example.com"]), [
    "gpu.lan.example.com",
  ]);
  table["gpu.lan.example.com"] = ["93.184.216.34"];
  assert.deepEqual(await verifier.verifyLanHosts(["http://gpu.lan.example.com"]), []);
});

test("verification expires after the TTL", async () => {
  let clock = 1_000;
  const { lookup } = fakeDns({ "gpu.lan.example.com": ["10.0.0.9"] });
  const verifier = createLanHostVerifier({ lookup, now: () => clock });

  await verifier.verifyLanHosts(["http://gpu.lan.example.com"]);
  assert.deepEqual(verifier.currentVerifiedHosts(), ["gpu.lan.example.com"]);
  clock += VERIFIED_TTL_MS + 1;
  assert.deepEqual(verifier.currentVerifiedHosts(), []);
});

test("hostnameOf reads scheme-less URLs and lower-cases the host", () => {
  assert.equal(hostnameOf("Sandcrawler.LAN.croz.net:8000/v1"), "sandcrawler.lan.croz.net");
  assert.equal(hostnameOf("https://Example.com/v1"), "example.com");
  assert.equal(hostnameOf(""), null);
  assert.equal(hostnameOf(null), null);
});
