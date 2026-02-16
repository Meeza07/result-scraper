const http = require('http');
const https = require('https');
const url = require('url');

// FORCE SSL BYPASS
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const PORT = process.env.PORT || 3000;
const BASE_URL = "https://coe.pgi-intraconnect.in/qpportal/app.php";

// ================== 1. THE BACKEND (Multi-Sem & Smart Logic) ==================

const pad = (num) => num.toString().padStart(4, '0');
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function secureGet(url) {
    return new Promise((resolve) => {
        const req = https.get(url, { rejectUnauthorized: false, headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); } catch (e) { resolve(null); }
            });
        });
        req.on('error', () => resolve(null));
        req.end();
    });
}

async function scrapeData(res, batchPrefix, start, end, univCode, yearModesInput) {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*'
    });

    const sendMsg = (type, data) => res.write(`data: ${JSON.stringify({ type, data })}\n\n`);

    // Split year codes (e.g., "C-2025-4, C-2024-3")
    const yearCodes = yearModesInput.split(',').map(s => s.trim()).filter(s => s);
    let foundCount = 0;

    sendMsg('log', `Starting extraction for ${yearCodes.length} semester(s)...`);

    for (let i = start; i <= end; i++) {
        const regNo = `${batchPrefix}${pad(i)}`;
        
        let aggregatedStudent = {
            regno: regNo,
            name: "Unknown",
            results: [],
            sgpa_history: []
        };

        let foundAny = false;

        // Loop through ALL year codes for this ONE student to build a cumulative history
        for (const yearMode of yearCodes) {
            
            const detUrl = `${BASE_URL}?db=pub&a=getDetailedResults&regno=${regNo}&univcode=${univCode}&yearmode=${yearMode}`;
            const detJson = await secureGet(detUrl);

            if (!detJson || detJson.status !== 'success' || !detJson.data || !detJson.data.studdet) {
                continue; // Try next semester code
            }

            foundAny = true;
            
            // Basic Info (Capture from the first successful sem)
            if (aggregatedStudent.name === "Unknown") {
                aggregatedStudent.name = detJson.data.studdet.name;
            }

            const briefUrl = `${BASE_URL}?db=pub&a=getBriefResults&regno=${regNo}&univcode=${univCode}&yearmode=${yearMode}`;
            const briefJson = await secureGet(briefUrl) || {};

            const grades = detJson.data.resdata || [];
            const marks = (briefJson.data && briefJson.data.data) ? briefJson.data.data : [];
            const currentSgpa = detJson.data.row2 ? detJson.data.row2.replace(/<[^>]*>/g, '').replace('SGPA:', '').trim() : "N/A";

            // Push SGPA history
            aggregatedStudent.sgpa_history.push({ sem: yearMode, sgpa: currentSgpa });

            // Merge Subjects
            const semesterSubjects = grades.map(g => {
                const markEntry = marks.find(m => m.subname.trim() === g.subname.trim());
                const breakdown = {};
                if (markEntry && markEntry.ssubname) {
                    markEntry.ssubname.forEach((label, idx) => breakdown[label] = markEntry.marks[idx]);
                }
                return {
                    subject: g.subname,
                    code: g.subshort,
                    grade: g.grade,
                    credits: g.no_of_credits,
                    marks: breakdown,
                    semester: yearMode // Tag the subject with its semester
                };
            });

            aggregatedStudent.results.push(...semesterSubjects);
        }

        if (foundAny) {
            // Calculate Cumulative Average (Simple Average of SGPAs found)
            let totalSgpa = 0;
            let validSems = 0;
            aggregatedStudent.sgpa_history.forEach(h => {
                let val = parseFloat(h.sgpa);
                if(!isNaN(val)) { totalSgpa += val; validSems++; }
            });
            aggregatedStudent.cgpa = validSems ? (totalSgpa / validSems).toFixed(2) : "0.00";
            
            // Use the latest SGPA for sorting, or CGPA if multiple sems
            aggregatedStudent.displayScore = validSems > 1 ? aggregatedStudent.cgpa : aggregatedStudent.sgpa_history[0]?.sgpa;

            sendMsg('result', aggregatedStudent);
            foundCount++;
        } else {
             sendMsg('scanning', regNo);
        }
        
        await sleep(50);
    }

    sendMsg('done', { count: foundCount });
    res.end();
}

// ================== 2. THE FRONTEND (v3.0 Pro Suite) ==================

const HTML_CONTENT = `
<!DOCTYPE html>
<html lang="en" class="light">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>Presidency Result Portal v3.0</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script>
        tailwind.config = {
            darkMode: 'class',
            theme: { extend: { colors: { dark: '#0f172a', card: '#1e293b' } } }
        }
    </script>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&family=Inter:wght@400;600;700&display=swap');
        body { font-family: 'Inter', sans-serif; -webkit-tap-highlight-color: transparent; }
        
        .grade-O { color: #16a34a; font-weight: bold; }
        .grade-A_ { color: #22c55e; font-weight: bold; }
        .grade-A { color: #4ade80; font-weight: bold; }
        .grade-B_ { color: #fbbf24; font-weight: bold; }
        .grade-B { color: #f59e0b; font-weight: bold; }
        .grade-C { color: #f97316; font-weight: bold; }
        .grade-F { color: #ef4444; font-weight: bold; background: #fee2e2; padding: 2px 6px; border-radius: 4px; }
        
        .dark .grade-F { background: #7f1d1d; color: #fca5a5; }
        .hidden-row { display: none; }
        .fade-in { animation: fadeIn 0.3s ease-in; }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: translateY(0); } }

        /* Mobile Layout */
        @media (max-width: 768px) {
            thead { display: none; }
            tr.main-row { 
                display: flex; flex-direction: column; 
                margin-bottom: 12px; padding: 12px;
                border-radius: 12px; border: 1px solid #e5e7eb;
            }
            .dark tr.main-row { border-color: #334155; }
            td { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px dashed #e5e7eb; }
            .dark td { border-color: #334155; }
            td:last-child { border-bottom: none; }
            td::before { 
                content: attr(data-label); font-weight: 600; font-size: 0.7rem; 
                text-transform: uppercase; color: #9ca3af; margin-right: 10px;
            }
            td[data-label="Student"] { text-align: right; }
            td[data-label="Student"] span { word-break: break-word; max-width: 200px; text-align: right; }
            td[data-label="#"] { display: none; }
            input { font-size: 16px !important; }
        }
    </style>
</head>
<body class="bg-gray-50 text-slate-800 dark:bg-dark dark:text-gray-100 p-4 md:p-6 pb-20 transition-colors duration-200">

    <div class="max-w-[1400px] mx-auto mb-6 flex justify-between items-center">
        <h1 class="text-xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-blue-600 to-indigo-600 flex items-center gap-2">
            <span>⚡</span> Result Portal <span class="text-xs bg-blue-100 text-blue-700 px-2 rounded-full hidden md:inline-block">v3.0</span>
        </h1>
        <button onclick="toggleTheme()" class="p-2 rounded-full bg-white dark:bg-card shadow-sm border border-gray-200 dark:border-gray-700">
            <span id="themeIcon">🌙</span>
        </button>
    </div>

    <div class="max-w-[1400px] mx-auto grid grid-cols-1 lg:grid-cols-4 gap-6">
        
        <div class="lg:col-span-1 space-y-6">
            <div class="bg-white dark:bg-card p-5 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 sticky top-6 z-10">
                
                <div class="space-y-3">
                    <div>
                        <label class="block text-xs font-semibold text-gray-500 uppercase mb-1">Batch / Roll No (Smart Search)</label>
                        <input type="text" id="batch" placeholder="20241CAI or Full Roll No" value="20241CAI" 
                            class="w-full px-3 py-2 border rounded-lg font-mono uppercase focus:ring-2 focus:ring-blue-500 outline-none bg-gray-50 dark:bg-slate-800 dark:border-gray-600">
                        <div class="text-[10px] text-gray-400 mt-1">✨ Tip: Enter full roll no (e.g., 20241CAI0007) to search just one person.</div>
                    </div>
                    
                    <div id="rangeInputs" class="grid grid-cols-2 gap-3 transition-all">
                        <div>
                            <label class="block text-xs font-semibold text-gray-500 uppercase mb-1">Start</label>
                            <input type="number" id="start" value="1" class="w-full px-3 py-2 border rounded-lg bg-gray-50 dark:bg-slate-800 dark:border-gray-600">
                        </div>
                        <div>
                            <label class="block text-xs font-semibold text-gray-500 uppercase mb-1">End</label>
                            <input type="number" id="end" value="60" class="w-full px-3 py-2 border rounded-lg bg-gray-50 dark:bg-slate-800 dark:border-gray-600">
                        </div>
                    </div>

                    <div>
                        <label class="block text-xs font-semibold text-gray-500 uppercase mb-1">Year Code(s)</label>
                        <input type="text" id="yearMode" value="C-2025-4" placeholder="C-2025-4, C-2024-3"
                            class="w-full px-3 py-2 border rounded-lg text-sm text-gray-600 dark:text-gray-300 bg-gray-50 dark:bg-slate-800 dark:border-gray-600">
                        <div class="text-[10px] text-gray-400 mt-1">Comma separate for Cumulative CGPA</div>
                    </div>

                    <div class="grid grid-cols-1 gap-2 pt-2">
                        <button onclick="toggleScrape()" id="btnScrape" class="w-full py-3 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg transition-all shadow-lg shadow-blue-500/30 flex justify-center items-center gap-2">
                            <span>Start Extraction</span>
                        </button>
                        <button onclick="downloadCSV()" id="btnDownload" class="hidden w-full py-3 bg-green-600 hover:bg-green-700 text-white font-medium rounded-lg transition-all">
                            Download Excel (CSV)
                        </button>
                    </div>
                </div>

                <div class="mt-4 pt-4 border-t border-gray-100 dark:border-gray-700">
                    <div class="flex justify-between items-center mb-2">
                        <div class="text-xs font-semibold text-gray-500 uppercase">Status</div>
                        <div id="statusText" class="text-xs font-mono text-gray-400">Idle</div>
                    </div>
                    <div class="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-1.5 mb-2 overflow-hidden">
                         <div id="progressBar" class="bg-blue-600 h-1.5 rounded-full transition-all duration-300" style="width: 0%"></div>
                    </div>
                </div>
            </div>
        </div>

        <div class="lg:col-span-3">
            <div class="bg-white dark:bg-card rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 overflow-hidden min-h-[500px] flex flex-col">
                
                <div class="px-4 py-4 border-b border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-slate-800 flex flex-col md:flex-row md:items-center justify-between gap-4">
                    <div class="flex items-center gap-3">
                        <h2 class="font-semibold text-gray-700 dark:text-gray-200">Results</h2>
                        <span class="bg-blue-100 dark:bg-blue-900 text-blue-800 dark:text-blue-200 text-xs font-bold px-2.5 py-0.5 rounded-full">
                            Found: <span id="countBadge">0</span>
                        </span>
                    </div>
                    
                    <div class="relative w-full md:w-64">
                        <input type="text" id="searchInput" onkeyup="filterTable()" placeholder="Filter results..." 
                            class="block w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg text-sm bg-white dark:bg-slate-700 dark:text-white focus:outline-none focus:ring-1 focus:ring-blue-500">
                    </div>
                </div>

                <div class="p-4 md:p-0 flex-grow">
                    <table class="w-full md:min-w-full divide-y divide-gray-200 dark:divide-gray-700">
                        <thead class="bg-gray-50 dark:bg-slate-800">
                            <tr>
                                <th onclick="sortData('index')" class="px-6 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase w-10">#</th>
                                <th onclick="sortData('name')" class="px-6 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase">Student</th>
                                <th onclick="sortData('regno')" class="px-6 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase">Reg No</th>
                                <th onclick="sortData('sgpa')" class="px-6 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase">SGPA/CGPA</th>
                                <th class="px-6 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase">Action</th>
                            </tr>
                        </thead>
                        <tbody class="bg-white dark:bg-card divide-y divide-gray-200 dark:divide-gray-700 block md:table-row-group" id="tableBody">
                        </tbody>
                    </table>
                </div>
                
                <div id="emptyState" class="flex flex-col items-center justify-center flex-grow text-gray-400 py-12">
                    <div class="text-4xl mb-2">📡</div>
                    <p>Ready to extract</p>
                </div>
            </div>
        </div>
    </div>

    <div id="calcModal" class="fixed inset-0 bg-black bg-opacity-50 hidden flex items-center justify-center z-50">
        <div class="bg-white dark:bg-card p-6 rounded-xl shadow-2xl w-80 border border-gray-200 dark:border-gray-600">
            <h3 class="text-lg font-bold mb-4 dark:text-white">Internal Splitter</h3>
            <p class="text-xs text-gray-500 mb-3">Total Internal (Scaled x2): <span id="modalTotal" class="font-bold text-blue-600">0</span></p>
            
            <label class="block text-xs font-semibold text-gray-500 uppercase mb-1">Your Mid Term (Out of 50)</label>
            <input type="number" id="calcMid" class="w-full px-3 py-2 border rounded-lg mb-4 dark:bg-slate-800 dark:border-gray-600 dark:text-white">
            
            <div class="p-3 bg-gray-50 dark:bg-slate-800 rounded-lg mb-4">
                <div class="text-xs text-gray-500">Calculated Assignment/Internal:</div>
                <div class="text-xl font-bold text-green-600" id="calcResult">--</div>
            </div>
            
            <div class="flex gap-2">
                <button onclick="closeCalc()" class="flex-1 py-2 bg-gray-200 dark:bg-gray-700 rounded-lg text-sm font-medium dark:text-white">Close</button>
                <button onclick="runCalc()" class="flex-1 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium">Calculate</button>
            </div>
        </div>
    </div>

    <script>
        let allStudents = [];
        let eventSource = null;
        let isRunning = false;
        let sortDirection = { name: 1, sgpa: -1, regno: 1, index: 1 }; 
        let currentCalcTotal = 0;

        // --- Dark Mode ---
        function toggleTheme() {
            const html = document.documentElement;
            if (html.classList.contains('dark')) {
                html.classList.remove('dark');
                document.getElementById('themeIcon').innerText = '🌙';
                localStorage.theme = 'light';
            } else {
                html.classList.add('dark');
                document.getElementById('themeIcon').innerText = '☀️';
                localStorage.theme = 'dark';
            }
        }
        if (localStorage.theme === 'dark' || (!('theme' in localStorage) && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
            document.documentElement.classList.add('dark');
            document.getElementById('themeIcon').innerText = '☀️';
        }

        // --- Smart Search Logic ---
        document.getElementById('batch').addEventListener('input', function(e) {
            const val = e.target.value.trim();
            const rangeDiv = document.getElementById('rangeInputs');
            
            // Heuristic: If length > 10, it's likely a full roll number
            if(val.length > 10) {
                rangeDiv.classList.add('opacity-50', 'pointer-events-none');
                document.getElementById('start').value = parseInt(val.slice(-4));
                document.getElementById('end').value = parseInt(val.slice(-4));
            } else {
                rangeDiv.classList.remove('opacity-50', 'pointer-events-none');
            }
        });

        function toggleScrape() {
            if (isRunning) stopScrape();
            else startScrape();
        }

        function startScrape() {
            isRunning = true;
            allStudents = [];
            renderTable();
            
            const btn = document.getElementById('btnScrape');
            btn.innerHTML = '<span class="animate-pulse">🛑 Stop Extraction</span>';
            btn.classList.replace('bg-blue-600', 'bg-red-500');
            
            document.getElementById('emptyState').classList.add('hidden');
            document.getElementById('btnDownload').classList.add('hidden');
            document.getElementById('statusText').innerText = "Connecting...";

            // Handle Smart Search Parsing
            const batchInput = document.getElementById('batch').value.trim();
            let batchPrefix = batchInput;
            let startVal = parseInt(document.getElementById('start').value);
            let endVal = parseInt(document.getElementById('end').value);

            if(batchInput.length > 10) {
                batchPrefix = batchInput.slice(0, -4);
                // Numbers already set by event listener, but double check
                startVal = parseInt(batchInput.slice(-4));
                endVal = startVal;
            }

            const total = endVal - startVal + 1;
            let processed = 0;

            const params = new URLSearchParams({
                batch: batchPrefix,
                start: startVal,
                end: endVal,
                year: document.getElementById('yearMode').value
            });
            
            if(eventSource) eventSource.close();
            eventSource = new EventSource('/api/scrape?' + params.toString());

            eventSource.onmessage = (event) => {
                const payload = JSON.parse(event.data);
                
                if (payload.type === 'scanning') {
                    processed++;
                    updateProgress(processed, total, payload.data);
                }
                else if (payload.type === 'result') {
                    processed++;
                    updateProgress(processed, total, payload.data.regno);
                    allStudents.push(payload.data);
                    // Sort by SGPA desc by default
                    allStudents.sort((a,b) => parseFloat(b.displayScore) - parseFloat(a.displayScore));
                    renderTable();
                } 
                else if (payload.type === 'done') {
                    finishScrape();
                }
            };

            eventSource.onerror = () => { if (isRunning) stopScrape(); };
        }

        function stopScrape() {
            if (eventSource) { eventSource.close(); eventSource = null; }
            isRunning = false;
            const btn = document.getElementById('btnScrape');
            btn.innerHTML = '<span>Start Extraction</span>';
            btn.classList.replace('bg-red-500', 'bg-blue-600');
            document.getElementById('statusText').innerText = "Stopped";
            document.getElementById('btnDownload').classList.remove('hidden');
        }

        function finishScrape() {
            stopScrape();
            document.getElementById('statusText').innerText = "Completed";
            document.getElementById('progressBar').style.width = '100%';
        }

        function updateProgress(current, total, info) {
            const pct = Math.min((current / total) * 100, 100);
            document.getElementById('progressBar').style.width = pct + '%';
            document.getElementById('statusText').innerText = \`Scanning \${info}...\`;
        }

        function sortData(key) {
            sortDirection[key] *= -1; 
            const dir = sortDirection[key];
            allStudents.sort((a, b) => {
                if (key === 'sgpa') return (parseFloat(a.displayScore) - parseFloat(b.displayScore)) * dir;
                else if (key === 'index') return a.regno.localeCompare(b.regno) * dir;
                else return a[key].localeCompare(b[key]) * dir;
            });
            renderTable();
        }

        function filterTable() {
            const term = document.getElementById('searchInput').value.toLowerCase();
            const filtered = allStudents.filter(s => s.name.toLowerCase().includes(term) || s.regno.toLowerCase().includes(term));
            renderTable(filtered);
        }

        function renderTable(dataOverride) {
            const tbody = document.getElementById('tableBody');
            tbody.innerHTML = '';
            const data = dataOverride || allStudents;
            document.getElementById('countBadge').innerText = data.length;
            
            if (data.length === 0 && allStudents.length === 0) {
                 document.getElementById('emptyState').classList.remove('hidden');
                 return;
            }
            document.getElementById('emptyState').classList.add('hidden');
            data.forEach((student, index) => appendStudentRow(student, index));
        }

        function appendStudentRow(student, index) {
            const tbody = document.getElementById('tableBody');
            const rowId = \`detail-\${student.regno}\`; 

            // Score Color
            let val = parseFloat(student.displayScore);
            let colorClass = "bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300";
            if(val >= 9) colorClass = "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-100";
            else if(val >= 8) colorClass = "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-100";
            else if(val < 6 && val > 0) colorClass = "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-100";

            const tr = document.createElement('tr');
            tr.className = "main-row hover:bg-gray-50 dark:hover:bg-slate-700 transition-colors cursor-pointer border-b border-gray-100 dark:border-gray-700 fade-in";
            tr.onclick = (e) => {
                if(!e.target.closest('button')) toggleDetails(rowId);
            };
            
            tr.innerHTML = \`
                <td class="px-6 py-4 text-sm text-gray-500 dark:text-gray-400" data-label="#">\${index + 1}</td>
                <td class="px-6 py-4 font-medium text-gray-900 dark:text-gray-100" data-label="Student"><span>\${student.name}</span></td>
                <td class="px-6 py-4 text-sm font-mono text-gray-500 dark:text-gray-400" data-label="Reg No">\${student.regno}</td>
                <td class="px-6 py-4" data-label="SGPA">
                    <span class="px-2.5 py-1 text-xs font-bold rounded-full \${colorClass}">\${student.displayScore}</span>
                </td>
                <td class="px-6 py-4 text-sm text-blue-500 hover:text-blue-700 cursor-pointer" data-label="Action">View Details</td>
            \`;
            tbody.appendChild(tr);

            const detailTr = document.createElement('tr');
            detailTr.id = rowId;
            detailTr.className = "hidden-row bg-gray-50 dark:bg-slate-800 border-b border-gray-200 dark:border-gray-700";
            
            // Total Credits Calc
            let totalCredits = 0;
            
            let subjectsHtml = student.results.map(sub => {
                if(sub.grade !== 'F') totalCredits += parseFloat(sub.credits || 0);
                
                let gradeClass = \`grade-\${sub.grade.replace('+','_')}\`;
                
                // --- MARKS TRANSFORMATION LOGIC (x2) ---
                let midTermTotal = 0;
                let endTermVal = 0;
                
                Object.entries(sub.marks).forEach(([key, val]) => {
                    let num = parseFloat(val);
                    if(key.toLowerCase().includes('end term')) endTermVal = num;
                    else midTermTotal += num; 
                });

                // Scale x2 as requested
                let displayMid = (midTermTotal > 0) ? (midTermTotal * 2) : 0;
                let displayEnd = (endTermVal > 0) ? (endTermVal * 2) : 0;

                return \`
                    <div class="bg-white dark:bg-card p-3 rounded-lg border border-gray-200 dark:border-gray-600 shadow-sm flex flex-col">
                        <div class="flex justify-between items-start mb-2">
                            <span class="text-xs font-bold text-gray-700 dark:text-gray-300 w-3/4 truncate" title="\${sub.subject}">\${sub.subject}</span>
                            <span class="\${gradeClass} text-sm">\${sub.grade}</span>
                        </div>
                        <div class="mt-auto border-t border-gray-100 dark:border-gray-600 pt-2 space-y-1">
                            <div class="flex justify-between text-xs text-gray-600 dark:text-gray-400">
                                <span>Internals (100):</span> 
                                <div class="flex items-center gap-1">
                                    <span class="font-mono font-bold">\${displayMid}</span>
                                    <button onclick="openCalc(\${displayMid})" class="text-[10px] bg-gray-200 dark:bg-gray-700 px-1 rounded hover:bg-gray-300">🧮</button>
                                </div>
                            </div>
                            <div class="flex justify-between text-xs text-gray-600 dark:text-gray-400">
                                <span>End Term (100):</span> 
                                <span class="font-mono font-bold">\${displayEnd}</span>
                            </div>
                            <div class="flex justify-between text-[10px] text-gray-400 mt-1">
                                <span>Credits: \${sub.credits}</span>
                            </div>
                        </div>
                    </div>\`;
            }).join('');

            detailTr.innerHTML = \`
                <td colspan="5" class="px-4 py-4 md:px-6">
                    <div class="mb-3 flex gap-2">
                        <span class="text-xs font-bold bg-green-100 text-green-800 px-2 py-1 rounded">Total Credits: \${totalCredits}</span>
                    </div>
                    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">\${subjectsHtml}</div>
                </td>\`;
            tbody.appendChild(detailTr);
        }

        function toggleDetails(id) {
            const el = document.getElementById(id);
            if (el.style.display === "block" || el.style.display === "table-row") el.style.display = "none";
            else el.style.display = window.innerWidth < 768 ? "block" : "table-row";
        }

        // --- CALCULATOR LOGIC ---
        function openCalc(total) {
            currentCalcTotal = total;
            document.getElementById('modalTotal').innerText = total;
            document.getElementById('calcMid').value = '';
            document.getElementById('calcResult').innerText = '--';
            document.getElementById('calcModal').classList.remove('hidden');
        }
        function closeCalc() {
            document.getElementById('calcModal').classList.add('hidden');
        }
        function runCalc() {
            const midRaw = parseFloat(document.getElementById('calcMid').value);
            if(isNaN(midRaw)) return;
            
            // Logic: TotalScaled = (Mid + Assignment) * 2
            // TotalScaled/2 = Mid + Assignment
            // Assignment = (TotalScaled/2) - Mid
            
            const totalRaw = currentCalcTotal / 2;
            const assignment = totalRaw - midRaw;
            
            document.getElementById('calcResult').innerText = assignment.toFixed(2);
            
            // Save locally
            localStorage.setItem('lastMidInput', midRaw);
        }

        function downloadCSV() {
            let csvContent = "data:text/csv;charset=utf-8,RegNo,Name,SGPA\n";
            allStudents.forEach(row => {
                csvContent += \`\${row.regno},\${row.name},\${row.displayScore}\n\`;
            });
            const encodedUri = encodeURI(csvContent);
            const link = document.createElement("a");
            link.setAttribute("href", encodedUri);
            link.setAttribute("download", "results.csv");
            document.body.appendChild(link);
            link.click();
            link.remove();
        }
    </script>
</body>
</html>
`;

// ================== 3. THE SERVER ==================

const server = http.createServer((req, res) => {
    const parsedUrl = url.parse(req.url, true);

    if (parsedUrl.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(HTML_CONTENT);
    } 
    else if (parsedUrl.pathname === '/api/scrape') {
        const { batch, start, end, year } = parsedUrl.query;
        scrapeData(res, batch || '20241CAI', parseInt(start)||1, parseInt(end)||60, '064', year || 'C-2025-4');
    } 
    else {
        res.writeHead(404);
        res.end("Not Found");
    }
});

server.listen(PORT, () => {
    console.log(`\n🚀 SERVER READY`);
});
