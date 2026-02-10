const http = require('http');
const https = require('https');
const url = require('url');

// FORCE SSL BYPASS
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const PORT = process.env.PORT || 3000;
const BASE_URL = "https://coe.pgi-intraconnect.in/qpportal/app.php";

// ================== 1. THE BACKEND (Scraper Logic) ==================

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

async function scrapeData(res, batchPrefix, start, end, univCode, yearMode) {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*'
    });

    const sendMsg = (type, data) => res.write(`data: ${JSON.stringify({ type, data })}\n\n`);

    let foundCount = 0;

    // Send initial ping to confirm connection
    sendMsg('log', 'Connected to server...');

    for (let i = start; i <= end; i++) {
        const regNo = `${batchPrefix}${pad(i)}`;
        
        // Notify frontend we are checking this ID
        // Note: The frontend decides if it wants to print this log
        
        const detUrl = `${BASE_URL}?db=pub&a=getDetailedResults&regno=${regNo}&univcode=${univCode}&yearmode=${yearMode}`;
        const detJson = await secureGet(detUrl);

        if (!detJson || detJson.status !== 'success' || !detJson.data || !detJson.data.studdet) {
            // Send a "scanning" event so the UI knows we are working, even if no result found
            sendMsg('scanning', regNo);
            await sleep(50);
            continue;
        }

        const briefUrl = `${BASE_URL}?db=pub&a=getBriefResults&regno=${regNo}&univcode=${univCode}&yearmode=${yearMode}`;
        const briefJson = await secureGet(briefUrl) || {};

        const info = detJson.data.studdet;
        const grades = detJson.data.resdata || [];
        const marks = (briefJson.data && briefJson.data.data) ? briefJson.data.data : [];

        const subjects = grades.map(g => {
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
                marks: breakdown
            };
        });

        let sgpa = detJson.data.row2 ? detJson.data.row2.replace(/<[^>]*>/g, '').replace('SGPA:', '').trim() : "0.00";

        const studentData = {
            regno: info.regno,
            name: info.name,
            sgpa: sgpa, 
            results: subjects
        };

        sendMsg('result', studentData);
        foundCount++;
        
        await sleep(50);
    }

    sendMsg('done', { count: foundCount });
    res.end();
}

// ================== 2. THE FRONTEND (Mobile Fixed + Stop Button) ==================

const HTML_CONTENT = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>Result Scraper</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap');
        body { font-family: 'Inter', sans-serif; -webkit-tap-highlight-color: transparent; }
        
        .grade-O { color: #16a34a; font-weight: bold; }
        .grade-A_ { color: #22c55e; font-weight: bold; }
        .grade-A { color: #4ade80; font-weight: bold; }
        .grade-B_ { color: #fbbf24; font-weight: bold; }
        .grade-B { color: #f59e0b; font-weight: bold; }
        .grade-C { color: #f97316; font-weight: bold; }
        .grade-F { color: #dc2626; font-weight: bold; background: #fee2e2; padding: 2px 6px; border-radius: 4px; }
        
        .hidden-row { display: none; }
        .fade-in { animation: fadeIn 0.3s ease-in; }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: translateY(0); } }

        /* --- MOBILE LAYOUT FIXES --- */
        @media (max-width: 768px) {
            thead { display: none; }
            
            /* Card Style for Rows */
            tr.main-row { 
                display: flex; 
                flex-direction: column; 
                background: white;
                border: 1px solid #e5e7eb; 
                border-radius: 12px; 
                margin-bottom: 12px; 
                box-shadow: 0 1px 2px rgba(0,0,0,0.05);
                padding: 12px;
                width: 100%;
            }
            
            /* Flex rows inside the card */
            td { 
                display: flex; 
                justify-content: space-between; 
                align-items: flex-start; /* Align top for multi-line names */
                padding: 8px 0; 
                border-bottom: 1px dashed #f3f4f6; 
                font-size: 14px;
                width: 100%;
            }
            
            td:last-child { border-bottom: none; }
            
            /* Labels */
            td::before { 
                content: attr(data-label); 
                font-weight: 600; 
                font-size: 0.7rem; 
                text-transform: uppercase; 
                color: #9ca3af; 
                min-width: 60px; /* Ensure label has space */
                margin-right: 10px;
                padding-top: 2px;
            }

            /* Fix for Long Names pushing content off screen */
            td[data-label="Student"] {
                text-align: right;
            }
            td[data-label="Student"] span {
                text-align: right;
                word-break: break-word; /* Force wrapping */
                max-width: 200px;       /* Limit width to prevent overflow */
                line-height: 1.3;
            }

            td[data-label="#"] { display: none; }
            input { font-size: 16px !important; }
        }
    </style>
</head>
<body class="bg-gray-100 min-h-screen text-slate-800 p-4 md:p-6 pb-20">

    <div class="max-w-[1400px] mx-auto grid grid-cols-1 lg:grid-cols-4 gap-6">
        
        <div class="lg:col-span-1 space-y-6">
            <div class="bg-white p-5 rounded-xl shadow-sm border border-gray-200 sticky top-6 z-10">
                <h1 class="text-lg font-bold bg-clip-text text-transparent bg-gradient-to-r from-blue-600 to-indigo-600 mb-4 flex items-center gap-2">
                    <span></span> Result Extraction of Presi Uni :)
                </h1>
                
                <div class="space-y-3">
                    <div>
                        <label class="block text-xs font-semibold text-gray-500 uppercase mb-1">Batch Prefix</label>
                        <input type="text" id="batch" value="20241CAI" class="w-full px-3 py-2 border rounded-lg font-mono uppercase focus:ring-2 focus:ring-blue-500 outline-none bg-gray-50">
                    </div>
                    <div class="grid grid-cols-2 gap-3">
                        <div>
                            <label class="block text-xs font-semibold text-gray-500 uppercase mb-1">Start</label>
                            <input type="number" id="start" value="1" class="w-full px-3 py-2 border rounded-lg bg-gray-50">
                        </div>
                        <div>
                            <label class="block text-xs font-semibold text-gray-500 uppercase mb-1">End</label>
                            <input type="number" id="end" value="60" class="w-full px-3 py-2 border rounded-lg bg-gray-50">
                        </div>
                    </div>
                    <div>
                        <label class="block text-xs font-semibold text-gray-500 uppercase mb-1">Year Code</label>
                        <input type="text" id="yearMode" value="C-2025-4" class="w-full px-3 py-2 border rounded-lg text-sm text-gray-500 bg-gray-50">
                    </div>

                    <div class="grid grid-cols-1 gap-2">
                        <button onclick="toggleScrape()" id="btnScrape" class="w-full py-3 bg-blue-600 active:bg-blue-800 text-white font-medium rounded-lg transition-all shadow-lg shadow-blue-500/30 flex justify-center items-center gap-2">
                            <span>Start Extraction</span>
                        </button>
                        
                        <button onclick="downloadJSON()" id="btnDownload" class="hidden w-full py-3 bg-green-600 active:bg-green-800 text-white font-medium rounded-lg transition-all">
                            Download JSON
                        </button>
                    </div>
                </div>

                <div class="mt-4 pt-4 border-t border-gray-100">
                    <div class="flex justify-between items-center mb-2">
                        <div class="text-xs font-semibold text-gray-500 uppercase tracking-wider">Live Logs/Credits to Meeza ifykyk</div>
                        <div id="statusText" class="text-xs font-mono text-gray-400">Idle</div>
                    </div>
                    <div class="w-full bg-gray-200 rounded-full h-1.5 mb-2 overflow-hidden">
                         <div id="progressBar" class="bg-blue-600 h-1.5 rounded-full" style="width: 0%"></div>
                    </div>
                </div>
            </div>
        </div>

        <div class="lg:col-span-3">
            <div class="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden min-h-[400px] flex flex-col">
                
                <div class="px-4 py-4 border-b border-gray-100 bg-gray-50 flex flex-col md:flex-row md:items-center justify-between gap-4">
                    <div class="flex items-center gap-3">
                        <h2 class="font-semibold text-gray-700">Results</h2>
                        <span class="bg-blue-100 text-blue-800 text-xs font-bold px-2.5 py-0.5 rounded-full border border-blue-200">
                            Found: <span id="countBadge">0</span>
                        </span>
                        <span class="bg-purple-100 text-purple-800 text-xs font-bold px-2.5 py-0.5 rounded-full border border-purple-200">
                            Avg: <span id="avgBadge">0.00</span>
                        </span>
                    </div>
                    
                    <div class="relative w-full md:w-64">
                        <input type="text" id="searchInput" onkeyup="filterTable()" placeholder="Search..." 
                            class="block w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-blue-500">
                    </div>
                </div>

                <div class="p-4 md:p-0 flex-grow">
                    <table class="w-full md:min-w-full divide-y divide-gray-200">
                        <thead class="bg-gray-50">
                            <tr>
                                <th onclick="sortData('index')" class="px-6 py-3 text-left text-xs font-semibold text-gray-500 uppercase w-10"># ↕</th>
                                <th onclick="sortData('name')" class="px-6 py-3 text-left text-xs font-semibold text-gray-500 uppercase">Student ↕</th>
                                <th onclick="sortData('regno')" class="px-6 py-3 text-left text-xs font-semibold text-gray-500 uppercase">Reg No ↕</th>
                                <th onclick="sortData('sgpa')" class="px-6 py-3 text-left text-xs font-semibold text-gray-500 uppercase">SGPA ↕</th>
                                <th class="px-6 py-3 text-left text-xs font-semibold text-gray-500 uppercase">Action</th>
                            </tr>
                        </thead>
                        <tbody class="bg-white divide-y divide-gray-200 block md:table-row-group" id="tableBody">
                            </tbody>
                    </table>
                </div>
                
                <div id="emptyState" class="flex flex-col items-center justify-center flex-grow text-gray-400 py-12">
                    <div class="text-4xl mb-2">📡</div>
                    <p>Ready to start</p>
                </div>
            </div>
        </div>
    </div>

    <script>
        let allStudents = [];
        let eventSource = null;
        let isRunning = false;
        let sortDirection = { name: 1, sgpa: -1, regno: 1, index: 1 }; 

        function toggleScrape() {
            if (isRunning) {
                stopScrape();
            } else {
                startScrape();
            }
        }

        function startScrape() {
            // UI Setup
            isRunning = true;
            allStudents = [];
            renderTable();
            
            const btn = document.getElementById('btnScrape');
            btn.innerHTML = '<span class="animate-pulse">🛑 Stop Extraction</span>';
            btn.classList.remove('bg-blue-600');
            btn.classList.add('bg-red-500');
            
            document.getElementById('emptyState').classList.add('hidden');
            document.getElementById('btnDownload').classList.add('hidden');
            document.getElementById('statusText').innerText = "Connecting...";

            const startVal = parseInt(document.getElementById('start').value);
            const endVal = parseInt(document.getElementById('end').value);
            const total = endVal - startVal + 1;
            let processed = 0;

            const params = new URLSearchParams({
                batch: document.getElementById('batch').value,
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
                    updateStats();
                    appendStudentRow(payload.data, allStudents.length - 1);
                } 
                else if (payload.type === 'done') {
                    finishScrape();
                }
            };

            eventSource.onerror = () => {
                // Usually closes when done or interrupted
                if (isRunning) stopScrape(); 
            };
        }

        function stopScrape() {
            if (eventSource) {
                eventSource.close();
                eventSource = null;
            }
            isRunning = false;
            
            // Reset Button
            const btn = document.getElementById('btnScrape');
            btn.innerHTML = '<span>Start Extraction</span>';
            btn.classList.remove('bg-red-500');
            btn.classList.add('bg-blue-600');
            
            document.getElementById('statusText').innerText = "Stopped";
            document.getElementById('btnDownload').classList.remove('hidden');
        }

        function finishScrape() {
            stopScrape();
            document.getElementById('statusText').innerText = "Completed";
            document.getElementById('progressBar').style.width = '100%';
        }

        function updateProgress(current, total, regno) {
            const pct = Math.min((current / total) * 100, 100);
            document.getElementById('progressBar').style.width = pct + '%';
            document.getElementById('statusText').innerText = \`Checking \${regno}...\`;
        }

        function updateStats() {
            document.getElementById('countBadge').innerText = allStudents.length;
            let total = 0, count = 0;
            allStudents.forEach(s => {
                let val = parseFloat(s.sgpa);
                if (!isNaN(val) && val > 0) { total += val; count++; }
            });
            let avg = count ? (total / count).toFixed(2) : "0.00";
            document.getElementById('avgBadge').innerText = avg;
        }

        function sortData(key) {
            sortDirection[key] *= -1; 
            const dir = sortDirection[key];
            allStudents.sort((a, b) => {
                if (key === 'sgpa') return (parseFloat(a.sgpa) - parseFloat(b.sgpa)) * dir;
                else if (key === 'index') return a.regno.localeCompare(b.regno) * dir;
                else return a[key].localeCompare(b[key]) * dir;
            });
            renderTable();
        }

        function filterTable() {
            const term = document.getElementById('searchInput').value.toLowerCase();
            const filtered = allStudents.filter(s => 
                s.name.toLowerCase().includes(term) || 
                s.regno.toLowerCase().includes(term)
            );
            renderTable(filtered);
        }

        function renderTable(dataOverride) {
            const tbody = document.getElementById('tableBody');
            tbody.innerHTML = '';
            const data = dataOverride || allStudents;
            
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

            let sgpaColor = "bg-gray-100 text-gray-800";
            let val = parseFloat(student.sgpa);
            if(val >= 9) sgpaColor = "bg-green-100 text-green-800";
            else if(val >= 8) sgpaColor = "bg-blue-100 text-blue-800";
            else if(val >= 6) sgpaColor = "bg-yellow-100 text-yellow-800";
            else if(val > 0 && val < 6) sgpaColor = "bg-red-100 text-red-800";

            const tr = document.createElement('tr');
            tr.className = "main-row hover:bg-gray-50 transition-colors cursor-pointer border-b border-gray-100 fade-in";
            tr.onclick = () => toggleDetails(rowId);
            
            // Note: Added <span> around the name for word-break targeting in CSS
            tr.innerHTML = \`
                <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500" data-label="#">\${index + 1}</td>
                <td class="px-6 py-4 font-medium text-gray-900" data-label="Student"><span>\${student.name}</span></td>
                <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500 font-mono" data-label="Reg No">\${student.regno}</td>
                <td class="px-6 py-4 whitespace-nowrap" data-label="SGPA">
                    <span class="px-2.5 py-1 inline-flex text-xs leading-5 font-bold rounded-full \${sgpaColor}">\${student.sgpa}</span>
                </td>
                <td class="px-6 py-4 whitespace-nowrap text-sm text-blue-500 hover:text-blue-700" data-label="Action">View Details</td>
            \`;
            tbody.appendChild(tr);

            const detailTr = document.createElement('tr');
            detailTr.id = rowId;
            detailTr.className = "hidden-row bg-gray-50 border-b border-gray-200";
            
            let subjectsHtml = student.results.map(sub => {
                let gradeClass = \`grade-\${sub.grade.replace('+','_')}\`;
                let marksStr = "";
                for (const [key, val] of Object.entries(sub.marks)) {
                    marksStr += \`<div class="flex justify-between text-xs text-gray-600 mt-1"><span>\${key}:</span> <span class="font-mono font-bold text-gray-800">\${val}</span></div>\`;
                }
                return \`
                    <div class="bg-white p-3 rounded-lg border border-gray-200 shadow-sm flex flex-col hover:shadow-md transition-shadow">
                        <div class="flex justify-between items-start mb-2">
                            <span class="text-xs font-bold text-gray-700 w-3/4 truncate" title="\${sub.subject}">\${sub.subject}</span>
                            <span class="\${gradeClass} text-sm">\${sub.grade}</span>
                        </div>
                        <div class="mt-auto border-t border-gray-100 pt-2">\${marksStr || '<span class="text-xs italic text-gray-400">No details</span>'}</div>
                    </div>\`;
            }).join('');

            detailTr.innerHTML = \`<td colspan="5" class="px-4 py-4 md:px-6"><div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">\${subjectsHtml}</div></td>\`;
            tbody.appendChild(detailTr);
        }

        function toggleDetails(id) {
            const el = document.getElementById(id);
            if (el.style.display === "block" || el.style.display === "table-row") {
                el.style.display = "none";
            } else {
                el.style.display = window.innerWidth < 768 ? "block" : "table-row";
            }
        }

        function downloadJSON() {
            const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(allStudents, null, 2));
            const a = document.createElement('a');
            a.href = dataStr; a.download = "final_results.json";
            document.body.appendChild(a); a.click(); a.remove();
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
