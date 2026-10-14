// Late phone, channel and email results may settle after the signed-in state changes. Their external
// sends still start for the state that authorized them, but no result or error may land in the next
// account's state. Internal senders are replaced with held promises; all state and service modules are
// fakes. Run: node --conditions=react-server scripts/test-result-state.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const targets = Object.fromEntries(["phone", "channels", "mail"].map((name) => [name, join(root, "lib/server", `${name}.ts`)]));
const targetNameByUrl = new Map(Object.entries(targets).map(([name, file]) => [pathToFileURL(file).href, name]));
const sourceOf = (name) => readFileSync(targets[name], "utf8");
const replaceOnce = (source, before, after, name) => {
  if (source.split(before).length !== 2) throw new Error(`${name}: test sender hook did not find exactly one ${before}`);
  return source.replace(before, after);
};

function fakeExports(target, specifier) {
  const source = stripTypeScriptTypes(sourceOf(target));
  const imports = new Map();
  for (const match of source.matchAll(/import\s*\{([\s\S]*?)\}\s*from\s*["']([^"']+)["']/g)) {
    if (match[2] !== specifier) continue;
    for (const item of match[1].split(",")) {
      const name = item.trim().split(/\s+as\s+/)[0];
      if (name) imports.set(name, true);
    }
  }
  const valueFor = (name) => {
    if (name === "sameState") return "() => { const epoch = globalThis.__bopsResultEpoch; return () => epoch === globalThis.__bopsResultEpoch; }";
    if (name === "stateEpoch") return "() => globalThis.__bopsResultEpoch";
    if (name === "getState") return "() => globalThis.__bopsResultState";
    if (name === "update") return "(fn) => fn(globalThis.__bopsResultState)";
    if (name === "addMessage") return "(message) => { const made = { ...message, id: `result-${++globalThis.__bopsResultMessageId}`, at: Date.now() }; globalThis.__bopsResultState.messages.push(made); return made; }";
    if (name === "bot") return "(id) => globalThis.__bopsResultState.bots?.find((x) => x.id === id)";
    if (name === "ofThisUser") return "() => true";
    if (name === "botChatId") return "(id) => `bot:${id}`";
    if (name === "workspaceOf") return "(bot) => bot?.workspaceId ?? 'workspace-test'";
    if (name === "watchChanges") return "() => undefined";
    if (name === "stateReady") return "() => true";
    if (name === "stateUser") return "() => 'user-test'";
    if (name === "userDir") return "() => null";
    if (name === "ownerName") return "() => 'Test Owner'";
    if (name === "installId") return "() => 'install-test'";
    if (name === "id") return "(prefix = 'test') => `${prefix}-id`";
    if (name === "pairCodeLive") return "() => false";
    if (name === "PAIR_CODE_MS") return "0";
    if (name === "MAIN_WORKSPACE") return "'workspace-test'";
    if (name === "BOPS_TIERS") return "{ max_bops: { emails: 5 } }";
    if (name === "live") return "{}";
    if (name === "TAPBACKS") return "[]";
    if (name === "CloudError") return "class CloudError extends Error {}";
    if (name === "AgentMailClient") return "class AgentMailClient {}";
    if (name === "openaiClient") return "() => ({})";
    return "(..._args) => undefined";
  };
  return [...imports.keys()].map((name) => `export const ${name} = ${valueFor(name)};`).join("\n") || "export {};";
}

registerHooks({
  resolve(specifier, context, next) {
    const target = targetNameByUrl.get(context.parentURL);
    if (target && !specifier.startsWith("node:"))
      return { url: `result-test:${target}:${encodeURIComponent(specifier)}`, shortCircuit: true };
    if (specifier.startsWith("@/")) specifier = pathToFileURL(join(root, specifier.slice(2))).href;
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith("result-test:")) {
      const [, target, encoded] = /^result-test:([^:]+):(.+)$/.exec(url) ?? [];
      return { format: "module", shortCircuit: true, source: fakeExports(target, decodeURIComponent(encoded)) };
    }
    const target = targetNameByUrl.get(url);
    if (target) {
      let source = sourceOf(target);
      if (target === "phone") source = replaceOnce(source, "void sendText(", "void globalThis.__bopsTestTextSend(", target);
      if (target === "channels") source = replaceOnce(source, "void send(", "void globalThis.__bopsTestChannelSend(", target);
      if (target === "mail") source = replaceOnce(source, "void emailOwner(", "void globalThis.__bopsTestEmailSend(", target);
      return { format: "module", shortCircuit: true, source: stripTypeScriptTypes(source) };
    }
    return next(url, context);
  },
});

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const settle = () => new Promise((resolve) => setImmediate(resolve));
const state = () => ({
  bots: [{ id: "bot-test", name: "Test bot", isMain: true, workspaceId: "workspace-test" }],
  ownerPhones: [{ number: "owner-number", verifiedAt: 1 }],
  channels: [{ id: "channel-test", kind: "slack", botId: "bot-test" }],
  messages: [{ id: "result-test" }],
});
globalThis.__bopsResultState = state();
globalThis.__bopsResultEpoch = 1;
globalThis.__bopsResultMessageId = 0;

const [phone, channels, mail] = await Promise.all([
  import(`${pathToFileURL(targets.phone).href}`),
  import(`${pathToFileURL(targets.channels).href}`),
  import(`${pathToFileURL(targets.mail).href}`),
]);
const session = {
  botId: "bot-test",
  textBack: { botId: "bot-test", to: "owner-number" },
  channelBack: { linkId: "channel-test", chat: "slack-channel", from: "owner-test" },
  emailBack: { inboxId: "inbox-test", messageId: "email-test" },
};
const swapState = () => {
  globalThis.__bopsResultState = state();
  globalThis.__bopsResultEpoch++;
};

// The send starts in the original epoch and is allowed to finish externally, but a late rejection
// cannot write its failure into the replacement account's chat.
{
  const held = deferred();
  let calls = 0;
  globalThis.__bopsTestTextSend = () => { calls++; return held.promise; };
  phone.textResult(session, "Old account result");
  assert.equal(calls, 1, "authorized text send starts immediately");
  swapState();
  held.reject(new Error("simulated text send failure"));
  await settle();
  assert.equal(globalThis.__bopsResultState.messages.length, 1, "late phone failure is not added to the new account");
}

// A failure in the same state still appears in the chat.
{
  const held = deferred();
  globalThis.__bopsTestTextSend = () => held.promise;
  phone.textResult(session, "Current account result");
  held.reject(new Error("current text send failure"));
  await settle();
  assert.match(globalThis.__bopsResultState.messages.at(-1).text, /Couldn't text this result back.*current text send failure/);
}

// Channel result failures have the same state boundary and retain their normal report.
{
  const held = deferred();
  let calls = 0;
  globalThis.__bopsTestChannelSend = () => { calls++; return held.promise; };
  channels.channelResult(session, "Old account result");
  assert.equal(calls, 1, "authorized channel send starts immediately");
  swapState();
  held.reject(new Error("simulated channel send failure"));
  await settle();
  assert.equal(globalThis.__bopsResultState.messages.length, 1, "late channel failure is not added to the new account");
}
{
  const held = deferred();
  globalThis.__bopsTestChannelSend = () => held.promise;
  channels.channelResult(session, "Current account result");
  held.reject(new Error("current channel send failure"));
  await settle();
  assert.match(globalThis.__bopsResultState.messages.at(-1).text, /Couldn't post this result to Slack.*current channel send failure/);
}

// An email reply already authorized before sign-out may finish, but its late local card update must
// not mark a coincidentally matching message in the next account as emailed.
{
  const held = deferred();
  let calls = 0;
  globalThis.__bopsTestEmailSend = () => { calls++; return held.promise; };
  mail.emailResult(session, "result-test", "Old account result");
  assert.equal(calls, 1, "authorized email send starts immediately");
  swapState();
  held.resolve("old-account-address");
  await settle();
  assert.equal(globalThis.__bopsResultState.messages[0].emailed, undefined, "late email result does not update the new account");
}
{
  const held = deferred();
  globalThis.__bopsTestEmailSend = () => held.promise;
  mail.emailResult(session, "result-test", "Current account result");
  held.resolve("current-account-address");
  await settle();
  assert.equal(globalThis.__bopsResultState.messages[0].emailed, "current-account-address", "same-state email result updates normally");
}
{
  const held = deferred();
  const warn = console.warn;
  console.warn = () => {};
  globalThis.__bopsTestEmailSend = () => held.promise;
  globalThis.bopsMail.lastError = undefined;
  mail.emailResult(session, "result-test", "Current account result");
  held.reject(new Error("current email send failure"));
  await settle();
  console.warn = warn;
  assert.match(globalThis.bopsMail.lastError, /email result: current email send failure/, "same-state email failures still reach mail status");
}

console.log("result state guards: held phone/channel/email results cannot write across an epoch swap; same-state failures and success still report");
