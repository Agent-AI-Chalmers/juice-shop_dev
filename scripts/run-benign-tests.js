const { spawnSync, spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ================= Configuration =================
const MANIFEST_PATH = path.resolve(__dirname, '../system_benign_manifest.json');
const TEST_ROOT = path.resolve(__dirname, '../test');
const BATCH_SIZE = 10; // Run 10 files per batch
const COOLDOWN_MS = 4000; // Cool down 4 seconds between batches

const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
const allBenign = manifest.benign || [];

// Result tracker
const report = {
    frontend: { status: 'Skipped', msg: '' },
    backend: { status: 'Skipped', msg: '' },
    cypress: { status: 'N/A', msg: 'No E2E tests in manifest' }
};

const jestGroups = {};
allBenign.forEach(t => {
    if (t.file.includes('api/') || t.file.includes('server/')) {
        const key = t.file.startsWith('test/') ? t.file.replace('test/', '') : t.file;
        if (!jestGroups[key]) jestGroups[key] = [];
        jestGroups[key].push(t.description);
    }
});

let chromePath = '';
try {
    chromePath = require('puppeteer').executablePath();
} catch (e) {
    console.warn('⚠️ Puppeteer not detected');
}

const commonEnv = {
    ...process.env,
    NODE_ENV: 'test',
    JUICE_SHOP_CONFIG: JSON.stringify({
        server: { rateLimit: 0 },
    }),
    CHROME_BIN: chromePath
};

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ================= Helper Functions =================

function escapeJestTestName(description) {
    return description
        .replace(/\\'/g, "'")
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildExactJestPattern(descriptions) {
    return `^(?:${descriptions.map(escapeJestTestName).join('|')})$`;
}

function applyTestExclusions(excludedTests, rootDir) {
    const modifiedFiles = new Set();
    if (!excludedTests || excludedTests.length === 0) return modifiedFiles;

    const fileMap = excludedTests.reduce((acc, item) => {
        if (!acc[item.file]) acc[item.file] = [];
        acc[item.file].push(item.description);
        return acc;
    }, {});

    console.log("🛡️ Applying physical patch to mute tests...");

    for (let [relPath, descriptions] of Object.entries(fileMap)) {
        let fullPath = path.resolve(rootDir, relPath);
        if (!fs.existsSync(fullPath) && !relPath.startsWith('frontend/')) {
            fullPath = path.resolve(rootDir, 'frontend', relPath);
        }

        if (!fs.existsSync(fullPath)) continue;

        try {
            let content = fs.readFileSync(fullPath, 'utf8');
            let isModified = false;

            descriptions.forEach(fullDesc => {
                const words = fullDesc.split(' ').filter(w => w.length > 2);
                const lastWords = words.slice(-3);
                const escapedWords = lastWords.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
                const pattern = escapedWords.join('.*?');

                const regex = new RegExp(`\\b(it|fit|test)\\s*\\(\\s*['"\`][^]*?${pattern}[^]*?['"\`]`, 'gi');

                if (regex.test(content)) {
                    content = content.replace(regex, (match) => match.startsWith('x') ? match : 'x' + match);
                    isModified = true;
                }
            });

            if (isModified) {
                fs.writeFileSync(fullPath, content);
                modifiedFiles.add(fullPath);
            }
        } catch (err) { }
    }
    return modifiedFiles;
}

function restoreTestFiles(modifiedFiles, rootDir) {
    if (modifiedFiles.size === 0) return;
    console.log(`\n🧹 Restoring ${modifiedFiles.size} files...`);
    for (const filePath of modifiedFiles) {
        try {
            execSync(`git checkout -- "${filePath}"`, { cwd: rootDir, stdio: 'ignore' });
        } catch (e) { }
    }
}

function killPort(port) {
    try {
        const cmd = process.platform === 'win32'
            ? `for /f "tokens=5" %a in ('netstat -aon ^| findstr :${port}') do taskkill /f /pid %a`
            : `lsof -t -i:${port} | xargs kill -9`;
        execSync(cmd, { stdio: 'ignore' });
    } catch (e) { }
}

// ================= Runners =================

async function runFrontendTests() {
    console.log(`\n[Frontend] Running Karma tests...`);
    return new Promise((resolve) => {
        const child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm',
            ['run', 'test', '--', '--no-progress', '--watch=false', '--browsers=ChromeHeadlessNoSandbox'],
            { cwd: path.resolve(__dirname, '../frontend'), env: commonEnv }
        );

        const noise = [/NG0955/, /Highlight\.js/, /Executed \d+ of \d+/, /key "" at index/, /Error during diffing/];

        child.stdout.on('data', (data) => {
            data.toString().split('\n').forEach(line => {
                if (!noise.some(p => p.test(line)) || line.includes('FAILED')) {
                    if (line.trim()) console.log(`  [Karma] ${line.trim()}`);
                }
            });
        });

        child.on('close', (code) => resolve(code === 0));
    });
}

async function runStandardTests() {
    console.log(`\n🛡️ Backend API regression | Target: ${Object.keys(jestGroups).length} files`);
    const jestFiles = Object.keys(jestGroups);
    let allPassed = true;

    for (let i = 0; i < jestFiles.length; i += BATCH_SIZE) {
        killPort(3000);
        await sleep(1000);
        const chunk = jestFiles.slice(i, i + BATCH_SIZE);
        const chunkPaths = chunk.map(f => path.join(TEST_ROOT, f));
        const chunkPatterns = buildExactJestPattern(
            chunk.flatMap(f => jestGroups[f])
        );

        const res = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', [
            'jest', '--silent', '--forceExit', '--runInBand', ...chunkPaths, '-t', chunkPatterns
        ], { cwd: path.resolve(__dirname, '..'), env: { ...commonEnv, PORT: 3000 }, stdio: 'inherit' });

        if (res.status !== 0) allPassed = false;
        if (i + BATCH_SIZE < jestFiles.length) await sleep(COOLDOWN_MS);
    }
    return allPassed;
}

async function runCypressWithServer(cypressFiles) {
    const projectRoot = path.resolve(__dirname, '..');
    const cleanSpecs = cypressFiles.map(f => f.startsWith('test/') ? f : path.join('test', f));

    console.log(`\n[Cypress] Starting server for E2E tests...`);
    const serverProcess = spawn('node', ['build/app'], { cwd: projectRoot, env: commonEnv });

    let isReady = false;
    for (let i = 0; i < 15; i++) {
        try {
            const res = spawnSync('node', ['-e', "require('http').get('http://localhost:3000', r => process.exit(r.statusCode===200?0:1)).on('error', ()=>process.exit(1))"]);
            if (res.status === 0) { isReady = true; break; }
        } catch (e) { }
        await sleep(1000);
    }

    if (!isReady) {
        console.error("❌ Cypress: Server failed to start on port 3000.");
        serverProcess.kill();
        return false;
    }

    console.log("✅ Server ready, running Cypress...");
    const res = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', [
        'cypress', 'run', '--browser', chromePath || 'electron', '--headless', '--spec', cleanSpecs.join(',')
    ], { cwd: projectRoot, env: commonEnv, stdio: 'inherit' });

    serverProcess.kill();
    return res.status === 0;
}

// ================= Main Flow =================

async function main() {
    let allPassed = true;
    const projectRoot = path.resolve(__dirname, '..');

    try {
        // 1. Frontend
        let modifiedFiles = new Set();
        try {
            modifiedFiles = applyTestExclusions(manifest.excluded || [], projectRoot);
            const frontendPassed = await runFrontendTests();
            report.frontend = frontendPassed
                ? { status: '✅ Passed', msg: '' }
                : { status: '❌ Failed', msg: 'Frontend Regressions found' };
            if (!frontendPassed) allPassed = false;
        } finally {
            restoreTestFiles(modifiedFiles, projectRoot);
        }

        // 2. Backend
        const apiPassed = await runStandardTests();
        report.backend = apiPassed
            ? { status: '✅ Passed', msg: '' }
            : { status: '❌ Failed', msg: 'Backend API Regressions found' };
        if (!apiPassed) allPassed = false;

        // 3. Cypress
        const cypressFiles = [...new Set(allBenign.filter(t => t.file.startsWith('cypress/')).map(t => t.file))];
        if (allPassed && cypressFiles.length > 0) {
            const cypressPassed = await runCypressWithServer(cypressFiles);
            report.cypress = cypressPassed
                ? { status: '✅ Passed', msg: '' }
                : { status: '❌ Failed', msg: 'E2E failures' };
            if (!cypressPassed) allPassed = false;
        } else if (cypressFiles.length > 0 && !allPassed) {
            report.cypress = { status: '🚫 Skipped', msg: 'Previous stages failed' };
        }

    } catch (err) {
        console.error('\n🚀 Critical Error:', err.message);
        allPassed = false;
    } finally {
        console.log('\n' + '='.repeat(50));
        console.log('📊 BLUE TEAM REGRESSION REPORT');
        console.log('='.repeat(50));
        console.log(`Frontend    : ${report.frontend.status} ${report.frontend.msg}`);
        console.log(`Backend API : ${report.backend.status} ${report.backend.msg}`);
        console.log(`Cypress E2E : ${report.cypress.status} ${report.cypress.msg}`);
        console.log('='.repeat(50));
        console.log(`OVERALL RESULT: ${allPassed ? '✅ SUCCESS' : '❌ FAILURE'}`);
        console.log('='.repeat(50) + '\n');

        process.exit(allPassed ? 0 : 1);
    }
}

main();
