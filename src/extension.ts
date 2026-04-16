import * as vscode from 'vscode';
import * as net from 'net';
import * as fs from 'fs';
import * as https from 'https';
import * as path from 'path';
import * as os from 'os';

const MNEMO_DIR = path.join(os.homedir(), '.mnemostroma');
const DEFAULT_CERT = path.join(MNEMO_DIR, 'certs', 'passthrough-ca.pem');
const CLAUDE_JSON = path.join(os.homedir(), '.claude.json');
const BRAIN_DIR = path.join(os.homedir(), '.gemini', 'antigravity', 'brain');
const CAPTURE_PORT = 8767;

let statusBar: vscode.StatusBarItem;
let proxyActive = false;

// ── Proxy check ───────────────────────────────────────────────────────

function checkProxy(port: number): Promise<boolean> {
    return new Promise(resolve => {
        const sock = new net.Socket();
        sock.setTimeout(1000);
        sock.on('connect', () => { sock.destroy(); resolve(true); });
        sock.on('error', () => resolve(false));
        sock.on('timeout', () => { sock.destroy(); resolve(false); });
        sock.connect(port, '127.0.0.1');
    });
}

// ── Env setup ─────────────────────────────────────────────────────────

function applyProxyEnv(port: number, certPath: string): void {
    const url = `https://localhost:${port}`;
    process.env['ANTHROPIC_BASE_URL'] = url;
    process.env['NODE_EXTRA_CA_CERTS'] = certPath;

    const cfg = vscode.workspace.getConfiguration();
    const termEnv = cfg.get<Record<string, string>>('terminal.integrated.env.linux') ?? {};
    if (termEnv['ANTHROPIC_BASE_URL'] !== url) {
        cfg.update(
            'terminal.integrated.env.linux',
            { ...termEnv, ANTHROPIC_BASE_URL: url, NODE_EXTRA_CA_CERTS: certPath },
            vscode.ConfigurationTarget.Global
        );
    }
}

function clearProxyEnv(): void {
    delete process.env['ANTHROPIC_BASE_URL'];
    delete process.env['NODE_EXTRA_CA_CERTS'];
}

// ── MCP auto-config ───────────────────────────────────────────────────

function ensureMcpRegistered(pythonPath: string): void {
    let data: Record<string, any> = {};
    if (fs.existsSync(CLAUDE_JSON)) {
        try { data = JSON.parse(fs.readFileSync(CLAUDE_JSON, 'utf8')); } catch { data = {}; }
    }
    const servers = data['mcpServers'] ?? {};
    if (servers['mnemostroma']) return;

    servers['mnemostroma'] = {
        type: 'stdio',
        command: pythonPath,
        args: ['-m', 'mnemostroma.integration.mcp_stdio_adapter'],
        env: {}
    };
    data['mcpServers'] = servers;
    fs.writeFileSync(CLAUDE_JSON, JSON.stringify(data, null, 2), 'utf8');
    vscode.window.showInformationMessage('Mnemostroma: MCP server registered in ~/.claude.json');
}

// ── Status bar ────────────────────────────────────────────────────────

function updateStatusBar(active: boolean): void {
    proxyActive = active;
    statusBar.text = active ? '$(circle-filled) mnemo' : '$(circle-slash) mnemo';
    statusBar.tooltip = active
        ? 'Mnemostroma proxy active — memory capture ON'
        : 'Mnemostroma proxy not detected — memory capture OFF';
    statusBar.backgroundColor = active
        ? undefined
        : new vscode.ThemeColor('statusBarItem.warningBackground');
    statusBar.color = active ? '#4EC9B0' : undefined;
    statusBar.show();
}

// ── Claude Code check ─────────────────────────────────────────────────

function checkClaudeCodeExtension(): void {
    const ext = vscode.extensions.getExtension('anthropic.claude-code');
    if (!ext) {
        vscode.window.showWarningMessage(
            'Mnemostroma: Claude Code extension not found. Memory capture requires it.',
            'Install Claude Code'
        ).then(choice => {
            if (choice === 'Install Claude Code') {
                vscode.commands.executeCommand('workbench.extensions.search', 'anthropic.claude-code');
            }
        });
    }
}

// ── Python path resolve ───────────────────────────────────────────────

function resolvePython(configured: string): string {
    if (configured) return configured;
    const venvPy = path.join(MNEMO_DIR, 'venv', 'bin', 'python3');
    if (fs.existsSync(venvPy)) return venvPy;
    return 'python3';
}

// ── Capture POST → daemon ─────────────────────────────────────────────

interface CapturePayload {
    text: string;
    session_id: string;
}

function postCapture(payload: CapturePayload): void {
    const body = JSON.stringify(payload);
    const req = https.request(
        { hostname: '127.0.0.1', port: CAPTURE_PORT, path: '/capture', method: 'POST',
          rejectUnauthorized: false,
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
        () => {}
    );
    req.on('error', () => {}); // silent — daemon may not be running
    req.write(body);
    req.end();
}

// ── Brain watcher (Antigravity right panel) ───────────────────────────

interface BrainSession {
    taskPosted: boolean;
    resolvedTimers: Map<string, NodeJS.Timeout>;
    watcher: fs.FSWatcher | null;
}

const brainSessions = new Map<string, BrainSession>();
const SESSION_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// matches task.md.resolved or walkthrough.md.resolved — final only (no trailing .N)
const FINAL_RESOLVED_RE = /^(.+)\.resolved$/;

function watchSessionDir(sessionId: string, sessionDir: string): void {
    if (brainSessions.has(sessionId)) return;

    const state: BrainSession = { taskPosted: false, resolvedTimers: new Map(), watcher: null };
    brainSessions.set(sessionId, state);

    // Read task.md if already exists
    scheduleTaskRead(sessionId, sessionDir, state);

    try {
        state.watcher = fs.watch(sessionDir, (event, filename) => {
            if (!filename) return;
            if (filename.endsWith('.metadata.json') || filename.endsWith('.env')) return;

            if (filename === 'task.md') {
                scheduleTaskRead(sessionId, sessionDir, state);
                return;
            }

            if (FINAL_RESOLVED_RE.test(filename) && !filename.match(/\.resolved\.\d+$/)) {
                scheduleResolvedRead(sessionId, sessionDir, filename, state);
            }
        });
    } catch {
        // session dir may be gone
    }
}

function scheduleTaskRead(sessionId: string, sessionDir: string, state: BrainSession): void {
    if (state.taskPosted) return;
    setTimeout(() => {
        if (state.taskPosted) return;
        const taskPath = path.join(sessionDir, 'task.md');
        if (!fs.existsSync(taskPath)) return;
        try {
            const content = fs.readFileSync(taskPath, 'utf8').trim();
            if (content) {
                postCapture({ text: content, session_id: sessionId });
                state.taskPosted = true;
            }
        } catch { /* ignore */ }
    }, 200);
}

function scheduleResolvedRead(
    sessionId: string, sessionDir: string, filename: string, state: BrainSession
): void {
    const existing = state.resolvedTimers.get(filename);
    if (existing) clearTimeout(existing);

    const t = setTimeout(() => {
        state.resolvedTimers.delete(filename);
        const filePath = path.join(sessionDir, filename);
        if (!fs.existsSync(filePath)) return;
        try {
            const content = fs.readFileSync(filePath, 'utf8').trim();
            if (content) {
                postCapture({ text: content, session_id: sessionId });
            }
        } catch { /* ignore */ }
    }, 500);

    state.resolvedTimers.set(filename, t);
}

function startBrainWatcher(disposables: vscode.Disposable[]): void {
    if (!fs.existsSync(BRAIN_DIR)) return;

    let brainWatcher: fs.FSWatcher;
    try {
        brainWatcher = fs.watch(BRAIN_DIR, (event, filename) => {
            if (!filename || !SESSION_UUID_RE.test(filename)) return;
            const sessionDir = path.join(BRAIN_DIR, filename);
            try {
                if (fs.existsSync(sessionDir) && fs.statSync(sessionDir).isDirectory()) {
                    watchSessionDir(filename, sessionDir);
                }
            } catch { /* ignore */ }
        });
    } catch {
        return;
    }

    disposables.push({ dispose: () => {
        brainWatcher.close();
        for (const s of brainSessions.values()) {
            s.watcher?.close();
            for (const t of s.resolvedTimers.values()) clearTimeout(t);
        }
        brainSessions.clear();
    }});
}

// ── Activation ────────────────────────────────────────────────────────

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('mnemostroma');
    const port = cfg.get<number>('proxyPort', 8767);
    const certPath = cfg.get<string>('certPath', '') || DEFAULT_CERT;
    const pythonPath = resolvePython(cfg.get<string>('pythonPath', ''));

    // Status bar
    statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 10000);
    statusBar.command = 'mnemostroma.toggle';
    context.subscriptions.push(statusBar);

    // Check Claude Code extension
    checkClaudeCodeExtension();

    // Check proxy and apply env
    const alive = await checkProxy(port);
    if (alive) {
        applyProxyEnv(port, certPath);
        ensureMcpRegistered(pythonPath);
    }
    updateStatusBar(alive);

    // Brain watcher — Antigravity right panel capture
    startBrainWatcher(context.subscriptions);

    // Poll proxy status every 30s
    const timer = setInterval(async () => {
        const now = await checkProxy(port);
        if (now !== proxyActive) {
            if (now) { applyProxyEnv(port, certPath); } else { clearProxyEnv(); }
            updateStatusBar(now);
        }
    }, 30000);
    context.subscriptions.push({ dispose: () => clearInterval(timer) });

    // Commands
    context.subscriptions.push(
        vscode.commands.registerCommand('mnemostroma.toggle', async () => {
            const now = await checkProxy(port);
            if (now) { applyProxyEnv(port, certPath); } else { clearProxyEnv(); }
            updateStatusBar(now);
        }),
        vscode.commands.registerCommand('mnemostroma.status', async () => {
            const now = await checkProxy(port);
            const msg = now
                ? `Mnemostroma proxy: ACTIVE on port ${port}`
                : `Mnemostroma proxy: OFFLINE (port ${port} not open)`;
            vscode.window.showInformationMessage(msg);
        })
    );
}

export function deactivate(): void {
    clearProxyEnv();
}
