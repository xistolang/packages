// The tests' exporter: prints each trace as a tree (a span under its parent; "<- remote" for a parent from another
// service), with its name, resource, type, kind, component, error and its tags sorted. No ids, times or hosts that
// change between runs.
import { Apm, ApmExporter, ApmServiceInfo, ApmSpan } from "xisto-apm";

/** print each span's ids too (tests that compare them with the logs' map them to labels) */
let showIds = false;
export function printIds(on: boolean): void {
  showIds = on;
}

function line(s: ApmSpan, depth: int, out: string[]): void {
  let pad = "";
  for (let i = 0; i < depth; i++) pad += "  ";
  const remote = s.parent === null && s.parentId.length > 0 ? " <- remote" : "";
  out.push(`${pad}${s.name} [${s.kind}] resource=${JSON.stringify(s.resource)} type=${s.type} component=${s.component}${remote}`);
  const keys: string[] = [];
  for (const k of s.tags.keys()) keys.push(k);
  for (const k of s.nums.keys()) keys.push(k);
  keys.sort();
  for (const k of keys) {
    const t = s.tags.get(k);
    out.push(`${pad}  ${k}=${t !== null ? t : String(s.nums.get(k))}`);
  }
  if (showIds) out.push(`${pad}  #trace=${s.traceIdHex()} #span=${s.ddSpanId()} #hex=${s.spanIdHex()}`);
  if (s.error) out.push(`${pad}  error: ${s.errorType}: ${s.errorMessage.split("\n")[0]}`);
}

function tree(spans: ApmSpan[], parent: ApmSpan | null, depth: int, out: string[]): void {
  for (const s of spans) {
    if (s.parent === parent) {
      line(s, depth, out);
      tree(spans, s, depth + 1, out);
    }
  }
}

export class PrintExporter implements ApmExporter {
  traces: string[] = [];
  /** values printed as a placeholder (a server's address, a user that depend on the environment) */
  masks: string[] = [];
  mask(value: string, placeholder: string): void {
    if (value.length > 0) {
      this.masks.push(value);
      this.masks.push(placeholder);
    }
  }
  async send(traces: ApmSpan[][]): Promise<void> {
    for (const t of traces) {
      const out: string[] = [];
      tree(t, null, 0, out);
      let text = out.join("\n");
      for (let i = 0; i + 1 < this.masks.length; i += 2) text = text.split(this.masks[i]).join(this.masks[i + 1]);
      this.traces.push(text);
    }
  }
  /** Flushes and prints every trace, in the order given (sorted: the order traces end can vary). */
  async print(sorted: boolean): Promise<void> {
    await Apm.flush();
    const all = this.traces.slice(0);
    if (sorted) all.sort();
    for (const t of all) console.log(t);
    this.traces = [];
  }
}

export function startApm(): PrintExporter {
  const info = new ApmServiceInfo();
  info.service = "shop";
  const ex = new PrintExporter();
  Apm.start(info, ex);
  return ex;
}
