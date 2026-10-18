export const CI_FILE = ".gitgood-ci.yml";

export interface CiStep {
  name: string;
  run: string;
}

export interface CiJob {
  id: string;
  name: string;
  runsOn: string;
  steps: CiStep[];
}

export interface CiWorkflow {
  name: string;
  triggers: Set<string>;
  jobs: CiJob[];
  warnings: string[];
  parseError?: string;
}

export function renderWorkflow(workflow: CiWorkflow): string {
  const out: string[] = [];
  out.push(`name: ${workflow.name}`);
  out.push("on:");
  for (const trigger of [...workflow.triggers].sort()) out.push(`  ${trigger}:`);
  out.push("jobs:");
  for (const job of workflow.jobs) {
    out.push(`  ${job.id}:`);
    out.push(`    name: ${job.name}`);
    out.push(`    runs-on: ${job.runsOn}`);
    if (job.steps.length > 0) {
      out.push("    steps:");
      for (const step of job.steps) {
        out.push(`      - name: ${step.name}`);
        if (step.run.includes("\n")) {
          out.push("        run: |");
          for (const line of step.run.split("\n")) out.push(`          ${line}`.trimEnd());
        } else {
          out.push(`        run: ${step.run}`);
        }
      }
    }
  }
  return out.join("\n") + "\n";
}

export function parseWorkflow(source: string): CiWorkflow {
  const warnings: string[] = [];
  const root = readYaml(source);
  if (root.kind !== "map") throw new Error(`${CI_FILE}: top level must be a mapping`);

  const name = stringField(root, "name") ?? "CI workflow";

  const triggers = new Set<string>();
  const onNode = child(root, "on");
  if (onNode === undefined) throw new Error(`${CI_FILE}: missing required "on:"`);
  if (onNode.kind === "map") {
    for (const [key, options] of Object.entries(onNode.value as Record<string, YamlNode>)) {
      noteTrigger(key, triggers, warnings);
      if (options.kind !== "scalar" || String(options.value).trim() !== "") warnings.push(`trigger "${key}" options are not implemented`);
    }
  } else if (onNode.kind === "list") {
    for (const item of onNode.value as YamlNode[]) {
      if (item.kind !== "scalar") continue;
      const trimmed = String(item.value).trim();
      if (!trimmed) continue;
      noteTrigger(trimmed, triggers, warnings);
    }
  } else if (onNode.kind === "scalar") {
    const value = String(onNode.value);
    for (const ev of value.split(",")) {
      const trimmed = ev.trim().replace(/^\[/, "").replace(/\]$/, "");
      if (trimmed) noteTrigger(trimmed, triggers, warnings);
    }
  }
  if (triggers.size === 0 && warnings.length === 0) throw new Error(`${CI_FILE}: "on:" must list at least one event`);

  const jobsNode = mapField(root, "jobs");
  if (!jobsNode) throw new Error(`${CI_FILE}: missing required "jobs:"`);

  const jobs: CiJob[] = [];
  for (const [id, jobRaw] of Object.entries(jobsNode)) {
    if (jobRaw.kind !== "map") throw new Error(`${CI_FILE}: job "${id}" must be a mapping`);
    const jobName = stringField(jobRaw, "name") ?? id;
    const runsOn = stringField(jobRaw, "runs-on") ?? "ubuntu-latest";
    const stepsNode = child(jobRaw, "steps");
    if (!stepsNode || stepsNode.kind !== "list") throw new Error(`${CI_FILE}: job "${id}" is missing "steps:"`);

    const unsupported = ["env", "if", "needs", "matrix", "with", "strategy", "services", "container", "defaults", "concurrency", "permissions", "timeout-minutes", "continue-on-error"];
    for (const key of unsupported) {
      if (child(jobRaw, key)) warnings.push(`job "${id}" uses "${key}:" which is not implemented`);
    }
    const steps: CiStep[] = [];
    for (const stepRaw of stepsNode.value as YamlNode[]) {
      if (stepRaw.kind !== "map") throw new Error(`${CI_FILE}: job "${id}" has a step that is not a mapping`);
      const run = stringField(stepRaw, "run");
      const uses = child(stepRaw, "uses");
      if (uses) warnings.push(`job "${id}" uses "uses:" which is not implemented yet`);
      if (run === undefined) {
        if (uses) continue;
        throw new Error(`${CI_FILE}: job "${id}" has a step without "run:"`);
      }
      for (const key of ["env", "if", "with", "working-directory", "continue-on-error", "timeout-minutes"]) {
        if (child(stepRaw, key)) warnings.push(`job "${id}" step uses "${key}:" which is not implemented`);
      }
      steps.push({ name: stringField(stepRaw, "name") ?? inferStepName(run, steps.length), run });
    }
    jobs.push({ id, name: jobName, runsOn, steps });
  }

  return { name, triggers, jobs, warnings };
}

const IMPLEMENTED_TRIGGERS = new Set(["push", "workflow_dispatch"]);

function noteTrigger(name: string, triggers: Set<string>, warnings: string[]): void {
  if (IMPLEMENTED_TRIGGERS.has(name)) triggers.add(name);
  else warnings.push(`trigger "${name}" is not implemented; only "push" and "workflow_dispatch" run`);
}

function inferStepName(run: string, index: number): string {
  const first = run.split("\n")[0]?.trim() ?? `step ${index + 1}`;
  return first.length > 40 ? `${first.slice(0, 37)}…` : first;
}

interface YamlNode {
  kind: "scalar" | "map" | "list";
  value: unknown;
}

interface Line {
  indent: number;
  text: string;
}

function readYaml(source: string): YamlNode {
  const cleaned: Line[] = [];
  for (const raw of source.replace(/\r\n/g, "\n").split("\n")) {
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    cleaned.push({ indent: raw.length - raw.trimStart().length, text: trimmed });
  }
  if (cleaned.length === 0) return { kind: "map", value: {} };

  let index = 0;

  const parseNode = (indent: number): YamlNode => {
    if (cleaned[index] === undefined) return { kind: "map", value: {} };
    if (cleaned[index]!.indent === indent && cleaned[index]!.text.startsWith("- ")) return parseList(indent);
    return parseMap(indent);
  };

  const parseList = (indent: number): YamlNode => {
    const items: YamlNode[] = [];
    while (index < cleaned.length && cleaned[index]!.indent === indent && cleaned[index]!.text.startsWith("- ")) {
      let rest = cleaned[index]!.text.slice(2).trim();
      index += 1;
      if (rest === "") {
        items.push(parseNode(indent + 2));
      } else if (findTopLevelColon(rest) >= 0) {
        items.push(parseMapFromFirst(indent + 2, rest));
      } else {
        items.push({ kind: "scalar", value: unquote(rest) });
      }
    }
    return { kind: "list", value: items };
  };

  const parseMap = (indent: number): YamlNode => {
    const map: Record<string, YamlNode> = {};
    while (index < cleaned.length && cleaned[index]!.indent === indent && !cleaned[index]!.text.startsWith("- ")) {
      const colon = findTopLevelColon(cleaned[index]!.text);
      if (colon < 0) throw new Error(`${CI_FILE}: expected "key:" but found ${JSON.stringify(cleaned[index]!.text)}`);
      const key = cleaned[index]!.text.slice(0, colon).trim();
      const valueText = cleaned[index]!.text.slice(colon + 1).trim();
      index += 1;
      if (valueText === "") {
        const next = cleaned[index];
        if (next && (next.text === "|" || next.text === ">")) {
          index += 1;
          const body: string[] = [];
          while (index < cleaned.length && cleaned[index]!.indent > indent) {
            body.push(cleaned[index]!.text);
            index += 1;
          }
          map[key] = { kind: "scalar", value: body.join("\n") };
        } else if (next && next.indent > indent) {
          map[key] = parseNode(next.indent);
        } else {
          map[key] = { kind: "scalar", value: "" };
        }
      } else {
        map[key] = { kind: "scalar", value: unquote(valueText) };
      }
    }
    return { kind: "map", value: map };
  };

  const parseMapFromFirst = (indent: number, firstKey: string): YamlNode => {
    const map: Record<string, YamlNode> = {};
    const colon = findTopLevelColon(firstKey);
    const key = firstKey.slice(0, colon).trim();
    const valueText = firstKey.slice(colon + 1).trim();
    if (valueText === "") map[key] = parseNode(indent + 2);
    else map[key] = { kind: "scalar", value: unquote(valueText) };
    while (index < cleaned.length && cleaned[index]!.indent === indent && !cleaned[index]!.text.startsWith("- ")) {
      const c = findTopLevelColon(cleaned[index]!.text);
      if (c < 0) break;
      const k = cleaned[index]!.text.slice(0, c).trim();
      const vt = cleaned[index]!.text.slice(c + 1).trim();
      index += 1;
      if (vt === "") map[k] = parseNode(indent + 2);
      else map[k] = { kind: "scalar", value: unquote(vt) };
    }
    return { kind: "map", value: map };
  };

  const node = parseNode(0);
  if (index < cleaned.length) throw new Error(`${CI_FILE}: unexpected content at line ${index + 1}`);
  return node;
}

function findTopLevelColon(text: string): number {
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === ":") {
      return i;
    }
  }
  return -1;
}

function unquote(value: string): string {
  if (value.length >= 2 && ((value[0] === '"' && value[value.length - 1] === '"') || (value[0] === "'" && value[value.length - 1] === "'"))) {
    const inner = value.slice(1, -1);
    return value[0] === '"' ? inner.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\") : inner;
  }
  return value;
}

function child(node: YamlNode, key: string): YamlNode | undefined {
  if (node.kind !== "map") return undefined;
  return (node.value as Record<string, YamlNode>)[key];
}

function stringField(node: YamlNode, key: string): string | undefined {
  const value = child(node, key);
  if (!value) return undefined;
  if (value.kind !== "scalar") throw new Error(`${CI_FILE}: "${key}" must be a single value`);
  return String(value.value);
}

function mapField(node: YamlNode, key: string): Record<string, YamlNode> | undefined {
  const value = child(node, key);
  if (!value) return undefined;
  if (value.kind !== "map") throw new Error(`${CI_FILE}: "${key}" must be a mapping`);
  return value.value as Record<string, YamlNode>;
}
