import type { ToolDefinition } from "../../types";
import { assertObject, asString } from "../../utils";
import { backend } from "../shared/backend";
import { timeoutBackgroundResult } from "../shared/background-result";
import { defaultHumanRenderer, defaultModelRenderer } from "../shared/renderers";

export type KaliToolMatch = {
  name: string;
  path: string;
  package?: string;
  description?: string;
  section?: string;
  category: string;
};

export type KaliToolSearchOutput = {
  query: string;
  inventoryCount: number;
  matches: KaliToolMatch[];
  guidance: string;
};

const KALI_CATEGORIES = [
  "information-gathering",
  "vulnerability",
  "web",
  "database",
  "passwords",
  "wireless",
  "reverse-engineering",
  "exploitation",
  "social-engineering",
  "sniffing-spoofing",
  "post-exploitation",
  "forensics",
  "reporting",
  "crypto-stego",
  "fuzzing",
  "general"
] as const;

const INVENTORY_SCRIPT = String.raw`
import glob, json, os, re, sys

query = sys.argv[1].strip().lower()
limit = max(1, min(20, int(sys.argv[2])))
category_filter = sys.argv[3].strip().lower()
refresh = sys.argv[4] == "1"
cache_path = "/tmp/farai-kali-tool-catalog-v1.json"
path_dirs = []
for item in os.environ.get("PATH", "").split(os.pathsep):
    item = os.path.realpath(item)
    if item and os.path.isdir(item) and item not in path_dirs:
        path_dirs.append(item)

def control_records(text):
    record = {}
    key = None
    for line in text.splitlines() + [""]:
        if not line:
            if record:
                yield record
            record = {}
            key = None
        elif line[0].isspace() and key:
            record[key] = record[key] + "\n" + line.strip()
        elif ":" in line:
            key, value = line.split(":", 1)
            record[key] = value.strip()

def fingerprint():
    tracked = ["/var/lib/dpkg/status"] + path_dirs
    return {path: int(os.stat(path).st_mtime_ns) for path in tracked if os.path.exists(path)}

current_fingerprint = fingerprint()
catalog = None
if not refresh:
    try:
        with open(cache_path, "r", encoding="utf-8") as handle:
            cached = json.load(handle)
        if cached.get("fingerprint") == current_fingerprint:
            catalog = cached.get("catalog")
    except Exception:
        catalog = None

if catalog is None:
    packages = {}
    try:
        with open("/var/lib/dpkg/status", "r", encoding="utf-8", errors="replace") as handle:
            for record in control_records(handle.read()):
                if record.get("Status") != "install ok installed":
                    continue
                name = record.get("Package", "")
                if not name:
                    continue
                packages[name] = {
                    "description": record.get("Description", "").split("\n", 1)[0],
                    "section": record.get("Section", "")
                }
    except OSError:
        pass

    commands = {}
    paths = {}
    for directory in path_dirs:
        try:
            names = os.listdir(directory)
        except OSError:
            continue
        for name in names:
            if not name or name in commands:
                continue
            path = os.path.join(directory, name)
            if os.path.isfile(path) and os.access(path, os.X_OK):
                commands[name] = path
                paths[path] = name
                paths[os.path.realpath(path)] = name

    command_packages = {}
    for list_path in glob.glob("/var/lib/dpkg/info/*.list"):
        package = os.path.basename(list_path)[:-5].split(":", 1)[0]
        try:
            with open(list_path, "r", encoding="utf-8", errors="ignore") as handle:
                for line in handle:
                    listed = line.strip()
                    command = paths.get(listed) or paths.get(os.path.realpath(listed))
                    if command and command not in command_packages:
                        command_packages[command] = package
        except OSError:
            pass

    supplemental = {
        "naabu": "fast SYN/CONNECT port scanner with JSONL output",
        "interactsh-client": "out-of-band interaction client for callback verification",
        "mitmproxy-mcp": "managed mitmproxy MCP bridge",
        "gopls": "Go language server",
        "rust-analyzer": "Rust language server",
        "uv": "Python package and environment manager",
        "uvx": "run Python tools in isolated environments"
    }
    category_rules = [
        ("information-gathering", r"\b(osint|recon|subdomain|dns|whois|network mapper|host discovery|scanner|enumerat)"),
        ("vulnerability", r"\b(vulnerab|security audit|assessment|cve|scanner)"),
        ("web", r"\b(web|http|https|url|directory|cms|proxy|browser)"),
        ("database", r"\b(database|sql|mysql|postgres|oracle|redis|mongodb)"),
        ("passwords", r"\b(password|hash|credential|brute force|cracker)"),
        ("wireless", r"\b(wireless|wifi|802\.11|bluetooth|rfid|radio|sdr)"),
        ("reverse-engineering", r"\b(reverse engineering|disassembl|decompil|binary analysis|debugger)"),
        ("exploitation", r"\b(exploit|payload|shellcode|metasploit)"),
        ("social-engineering", r"\b(social engineering|phishing)"),
        ("sniffing-spoofing", r"\b(sniff|spoof|packet capture|mitm|man.in.the.middle)"),
        ("post-exploitation", r"\b(post.exploit|privilege escalation|lateral movement|pivot)"),
        ("forensics", r"\b(forensic|disk image|memory analysis|recovery|carv)"),
        ("reporting", r"\b(report|documentation|evidence)"),
        ("crypto-stego", r"\b(crypt|cipher|stegan|encode|decode)"),
        ("fuzzing", r"\b(fuzz|mutation|wordlist)"),
    ]

    catalog = []
    for name, path in commands.items():
        package = command_packages.get(name, "")
        metadata = packages.get(package, {})
        description = supplemental.get(name, metadata.get("description", ""))
        section = metadata.get("section", "")
        haystack = " ".join([name, package, description, section]).lower()
        category = "general"
        for candidate, pattern in category_rules:
            if re.search(pattern, haystack):
                category = candidate
                break
        catalog.append({
            "name": name,
            "path": path,
            "package": package,
            "description": description,
            "section": section,
            "category": category
        })
    catalog.sort(key=lambda item: item["name"].lower())
    try:
        with open(cache_path, "w", encoding="utf-8") as handle:
            json.dump({"fingerprint": current_fingerprint, "catalog": catalog}, handle, separators=(",", ":"))
    except OSError:
        pass

aliases = {
    "subdomain": ["subfinder", "amass", "assetfinder", "findomain", "sublist3r", "dnsrecon", "dnsenum"],
    "passive dns": ["subfinder", "amass", "theHarvester", "recon-ng"],
    "certificate transparency": ["subfinder", "amass", "assetfinder"],
    "port scan": ["naabu", "nmap", "masscan", "unicornscan"],
    "web content": ["ffuf", "feroxbuster", "gobuster", "dirsearch", "dirb"],
    "web vulnerability": ["nuclei", "nikto", "wapiti", "whatweb", "wpscan"],
    "password crack": ["hashcat", "john", "hydra", "medusa", "ncrack"],
    "packet capture": ["tcpdump", "tshark", "wireshark", "dumpcap"],
    "reverse engineering": ["gdb", "radare2", "r2", "ghidra", "objdump", "readelf"],
    "forensics": ["volatility3", "autopsy", "binwalk", "foremost", "yara", "sleuthkit"],
    "sql injection": ["sqlmap", "ghauri"],
    "fuzz": ["afl-fuzz", "ffuf", "wfuzz", "radamsa", "honggfuzz"],
    "callback": ["interactsh-client", "socat", "ncat", "nc"]
}
tokens = re.findall(r"[a-z0-9_.+-]{2,}", query)
boosted = set()
for phrase, names in aliases.items():
    if phrase in query or all(word in query for word in phrase.split()):
        boosted.update(name.lower() for name in names)

ranked = []
for item in catalog:
    if category_filter and category_filter != "all" and item["category"] != category_filter:
        continue
    name = item["name"].lower()
    package = item.get("package", "").lower()
    description = item.get("description", "").lower()
    section = item.get("section", "").lower()
    category = item.get("category", "").lower()
    score = 0
    if name == query:
        score += 200
    if name in boosted:
        score += 100
    for token in tokens:
        if name == token:
            score += 60
        elif token in name:
            score += 24
        if package == token:
            score += 30
        elif token in package:
            score += 12
        if token in description:
            score += 8
        if token in category:
            score += 6
        if token in section:
            score += 2
    if score > 0:
        ranked.append((score, item))

ranked.sort(key=lambda pair: (-pair[0], pair[1]["name"].lower()))
matches = []
for score, item in ranked[:limit]:
    cleaned = {key: value for key, value in item.items() if value}
    matches.append(cleaned)
print(json.dumps({
    "query": query,
    "inventoryCount": len(catalog),
    "matches": matches,
    "guidance": "prefer a typed Farai capability when one exists; otherwise inspect the selected command's local man page or --help once, then execute it with shell_exec using machine-readable output and bounded scope"
}, ensure_ascii=True, separators=(",", ":")))
`;

export function kaliToolSearchCommand(input: { query: string; limit: number; category?: string; refresh?: boolean }): string {
  return [
    "python3",
    "-c",
    shellQuote(INVENTORY_SCRIPT),
    shellQuote(input.query),
    shellQuote(String(input.limit)),
    shellQuote(input.category ?? "all"),
    shellQuote(input.refresh ? "1" : "0")
  ].join(" ");
}

export function parseKaliToolSearchOutput(raw: string): KaliToolSearchOutput {
  const parsed = JSON.parse(raw.trim()) as Partial<KaliToolSearchOutput>;
  if (typeof parsed.query !== "string" || !Number.isInteger(parsed.inventoryCount) || !Array.isArray(parsed.matches)) {
    throw new Error("invalid Kali tool inventory response");
  }
  const matches = parsed.matches.filter((match): match is KaliToolMatch => Boolean(
    match
    && typeof match === "object"
    && typeof match.name === "string"
    && typeof match.path === "string"
    && typeof match.category === "string"
  ));
  return {
    query: parsed.query,
    inventoryCount: parsed.inventoryCount!,
    matches,
    guidance: typeof parsed.guidance === "string" ? parsed.guidance : "inspect local documentation before first use"
  };
}

export const kaliToolSearchTool: ToolDefinition = {
  name: "kali_tool_search",
  description: "search the actual installed Kali command inventory by capability, package description, official-style category, or exact binary name; use this instead of guessing commands or using tool_search for Kali binaries",
  inputSchema: {
    type: "object",
    required: ["query"],
    properties: {
      query: { type: "string", description: "task or capability, such as 'passive subdomain enumeration', 'Kerberos credential attacks', or an exact command name" },
      category: { type: "string", enum: [...KALI_CATEGORIES, "all"] },
      limit: { type: "integer", minimum: 1, maximum: 20 },
      refresh: { type: "boolean", description: "rebuild the inventory only when installed commands changed during this container session" }
    },
    additionalProperties: false
  },
  mutates: false,
  timeoutMs: 30_000,
  parallel: true,
  renderHuman: defaultHumanRenderer,
  renderModel: defaultModelRenderer,
  run: async (args, context) => {
    assertObject(args, "args");
    const query = asString(args.query, "query").trim();
    if (query.length > 500) throw new Error("query must be at most 500 characters");
    const limit = typeof args.limit === "number" && Number.isInteger(args.limit) ? Math.max(1, Math.min(20, args.limit)) : 8;
    const category = typeof args.category === "string" ? args.category : undefined;
    const kali = backend(context);
    const result = await kali.exec(kaliToolSearchCommand({ query, limit, ...(category ? { category } : {}), refresh: args.refresh === true }), 25_000, context.signal, 32_000);
    const converted = timeoutBackgroundResult("kali tool inventory", kali, result);
    if (converted) return converted;
    if (result.exitCode !== 0) {
      return {
        ok: false,
        summary: "kali tool inventory failed",
        output: (result.stderr || result.stdout || "inventory command produced no output").trim()
      };
    }
    try {
      const parsed = parseKaliToolSearchOutput(result.stdout);
      return {
        ok: true,
        summary: `found ${parsed.matches.length} relevant commands across ${parsed.inventoryCount} installed executables`,
        output: JSON.stringify(parsed, null, 2),
        metadata: {
          inventoryCount: parsed.inventoryCount,
          matchedCommands: parsed.matches.map((match) => match.name),
          category: category ?? "all"
        }
      };
    } catch (error) {
      return {
        ok: false,
        summary: "kali tool inventory returned invalid data",
        output: error instanceof Error ? error.message : String(error)
      };
    }
  }
};

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
