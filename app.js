const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

// FORCE SSL BYPASS
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const PORT = 3000;
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

    for (let i = start; i <= end; i++) {
        const regNo = `${batchPrefix}${pad(i)}`;
        sendMsg('log', `Fetching ${regNo}...`);

        const detUrl = `${BASE_URL}?db=pub&a=getDetailedResults&regno=${regNo}&univcode=${univCode}&yearmode=${yearMode}`;
        const detJson = await secureGet(detUrl);

        if (!detJson || detJson.status !== 'success' || !detJson.data || !detJson.data.studdet) {
            // Fast skip if empty
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
            sgpa: sgpa, // Keep as string for display, convert for sort
            results: subjects
        };

        sendMsg('result', studentData);
        foundCount++;
        
        await sleep(50);
    }

    sendMsg('done', { count: foundCount });
    res.end();
}

// ================== 2. THE FRONTEND (HTML/CSS/JS) ==================

const HTML_CONTENT = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>University Result Scraper</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap');
        body { font-family: 'Inter', sans-serif; }
        .grade-O { color: #16a34a; font-weight: bold; }
        .grade-A_ { color: #22c55e; font-weight: bold; }
        .grade-A { color: #4ade80; font-weight: bold; }
        .grade-B_ { color: #fbbf24; font-weight: bold; }
        .grade-B { color: #f59e0b; font-weight: bold; }
        .grade-C { color: #f97316; font-weight: bold; }
        .grade-F { color: #dc2626; font-weight: bold; background: #fee2e2; padding: 2px 6px; border-radius: 4px; }
        .hidden-row { display: none; }
        
        /* Smooth fade for new rows */
        .fade-in { animation: fadeIn 0.3s ease-in; }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: translateY(0); } }
        
        th { cursor: pointer; user-select: none; }
        th:hover { background-color: #f3f4f6; }
    </style>
</head>
<body class="bg-gray-100 min-h-screen text-slate-800 p-6">

    <div class="max-w-[1400px] mx-auto grid grid-cols-1 lg:grid-cols-4 gap-6">
        
        <div class="lg:col-span-1 space-y-6">
            <div class="bg-white p-6 rounded-xl shadow-sm border border-gray-200 sticky top-6">
                <h1 class="text-xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-blue-600 to-indigo-600 mb-4 flex items-center gap-2">
                    <span></span> Result Scraper Presidency University
                </h1>
                
                <div class="space-y-4">
                    <div>
                        <label class="block text-sm font-medium text-gray-700 mb-1">Batch Prefix</label>
                        <input type="text" id="batch" value="20241CAI" class="w-full px-3 py-2 border rounded-lg font-mono uppercase focus:ring-2 focus:ring-blue-500 outline-none">
                    </div>
                    <div class="grid grid-cols-2 gap-3">
                        <div>
                            <label class="block text-sm font-medium text-gray-700 mb-1">Start</label>
                            <input type="number" id="start" value="1" class="w-full px-3 py-2 border rounded-lg">
                        </div>
                        <div>
                            <label class="block text-sm font-medium text-gray-700 mb-1">End</label>
                            <input type="number" id="end" value="60" class="w-full px-3 py-2 border rounded-lg">
                        </div>
                    </div>
                    <div>
                        <label class="block text-sm font-medium text-gray-700 mb-1">Year Code</label>
                        <input type="text" id="yearMode" value="C-2025-4" class="w-full px-3 py-2 border rounded-lg text-sm text-gray-500">
                    </div>

                    <button onclick="startScrape()" id="btnScrape" class="w-full py-2.5 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg transition-all shadow-lg shadow-blue-500/30 flex justify-center items-center gap-2">
                        <span>Start Extraction</span>
                    </button>
                    
                    <button onclick="downloadJSON()" id="btnDownload" class="w-full py-2.5 bg-green-600 hover:bg-green-700 text-white font-medium rounded-lg transition-all hidden">
                        Download JSON
                    </button>
                </div>

                <div class="mt-6 pt-6 border-t border-gray-100">
                    <div class="flex justify-between items-center mb-2">
                        <div class="text-xs font-semibold text-gray-500 uppercase tracking-wider">Live Logs</div>
                        <div class="text-xs text-blue-600 cursor-pointer" onclick="document.getElementById('logs').innerHTML=''">Clear</div>
                    </div>
                    <div id="logs" class="h-32 overflow-y-auto bg-gray-900 text-green-400 text-xs font-mono p-3 rounded-lg shadow-inner">
                        <div class="text-gray-500 italic">Ready to start...</div>
                    </div>
                </div>
            </div>
        </div>

        <div class="lg:col-span-3">
            <div class="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden min-h-[600px] flex flex-col">
                
                <div class="px-6 py-4 border-b border-gray-100 bg-gray-50 flex flex-col md:flex-row md:items-center justify-between gap-4">
                    <div class="flex items-center gap-4">
                        <h2 class="font-semibold text-gray-700 text-lg">Results</h2>
                        <span class="bg-blue-100 text-blue-800 text-xs font-bold px-2.5 py-0.5 rounded-full border border-blue-200">
                            Found: <span id="countBadge">0</span>
                        </span>
                        <span class="bg-purple-100 text-purple-800 text-xs font-bold px-2.5 py-0.5 rounded-full border border-purple-200" title="Class Average SGPA">
                            Avg: <span id="avgBadge">0.00</span>
                        </span>
                    </div>
                    
                    <div class="relative w-full md:w-64">
                        <div class="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                            <svg class="h-4 w-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/></svg>
                        </div>
                        <input type="text" id="searchInput" onkeyup="filterTable()" placeholder="Search Name or RegNo..." 
                            class="block w-full pl-10 pr-3 py-2 border border-gray-300 rounded-lg leading-5 bg-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500 sm:text-sm">
                    </div>
                </div>

                <div class="overflow-x-auto flex-grow">
                    <table class="min-w-full divide-y divide-gray-200">
                        <thead class="bg-gray-50">
                            <tr>
                                <th onclick="sortData('index')" class="px-6 py-3 text-left text-xs font-semibold text-gray-500 uppercase w-10"># ↕</th>
                                <th onclick="sortData('name')" class="px-6 py-3 text-left text-xs font-semibold text-gray-500 uppercase">Student ↕</th>
                                <th onclick="sortData('regno')" class="px-6 py-3 text-left text-xs font-semibold text-gray-500 uppercase">Reg No ↕</th>
                                <th onclick="sortData('sgpa')" class="px-6 py-3 text-left text-xs font-semibold text-gray-500 uppercase">SGPA ↕</th>
                                <th class="px-6 py-3 text-left text-xs font-semibold text-gray-500 uppercase">Action</th>
                            </tr>
                        </thead>
                        <tbody class="bg-white divide-y divide-gray-200" id="tableBody">
                            </tbody>
                    </table>
                </div>
                
                <div id="emptyState" class="flex flex-col items-center justify-center flex-grow text-gray-400 py-12">
                    <div class="text-4xl mb-2">📡</div>
                    <p>Click "Start Extraction" to begin</p>
                </div>
            </div>
        </div>
    </div>

    <script>
        let allStudents = [];
        let eventSource = null;
        let sortDirection = { name: 1, sgpa: -1, regno: 1, index: 1 }; // -1 for desc

        function log(msg) {
            const logs = document.getElementById('logs');
            const div = document.createElement('div');
            div.textContent = "> " + msg;
            logs.appendChild(div);
            logs.scrollTop = logs.scrollHeight;
        }

        function startScrape() {
            // Reset state
            allStudents = [];
            renderTable();
            document.getElementById('emptyState').classList.add('hidden');
            document.getElementById('btnDownload').classList.add('hidden');
            document.getElementById('btnScrape').disabled = true;
            document.getElementById('btnScrape').classList.add('opacity-50');
            document.getElementById('btnScrape').innerHTML = '<span class="animate-spin">↻</span> Extracting...';

            const params = new URLSearchParams({
                batch: document.getElementById('batch').value,
                start: document.getElementById('start').value,
                end: document.getElementById('end').value,
                year: document.getElementById('yearMode').value
            });
            
            if(eventSource) eventSource.close();
            eventSource = new EventSource('/api/scrape?' + params.toString());

            eventSource.onmessage = (event) => {
                const payload = JSON.parse(event.data);
                
                if (payload.type === 'log') {
                    log(payload.data);
                } else if (payload.type === 'result') {
                    allStudents.push(payload.data);
                    // Update stats
                    updateStats();
                    // Append only the new row (Efficient for live loading)
                    appendStudentRow(payload.data, allStudents.length - 1);
                } else if (payload.type === 'done') {
                    log(\`✅ DONE! Found \${payload.data.count} students.\`);
                    finishScrape();
                }
            };

            eventSource.onerror = () => {
                log("❌ Connection Closed / Error.");
                finishScrape();
            };
        }

        function finishScrape() {
            if(eventSource) eventSource.close();
            document.getElementById('btnScrape').disabled = false;
            document.getElementById('btnScrape').classList.remove('opacity-50');
            document.getElementById('btnScrape').innerHTML = '<span>Start Extraction</span>';
            document.getElementById('btnDownload').classList.remove('hidden');
        }

        function updateStats() {
            document.getElementById('countBadge').innerText = allStudents.length;
            
            // Calc Avg
            let total = 0, count = 0;
            allStudents.forEach(s => {
                let val = parseFloat(s.sgpa);
                if (!isNaN(val) && val > 0) { total += val; count++; }
            });
            let avg = count ? (total / count).toFixed(2) : "0.00";
            document.getElementById('avgBadge').innerText = avg;
        }

        // ================= SORTING & FILTERING =================

        function sortData(key) {
            sortDirection[key] *= -1; // Toggle direction
            const dir = sortDirection[key];

            allStudents.sort((a, b) => {
                if (key === 'sgpa') {
                    // Numeric sort for SGPA
                    return (parseFloat(a.sgpa) - parseFloat(b.sgpa)) * dir;
                } else if (key === 'index') {
                    // We don't store index, so we can't easily revert to original order 
                    // unless we added an ID. For now, let's just sort by RegNo as default
                    return a.regno.localeCompare(b.regno) * dir;
                } else {
                    // String sort for Name/RegNo
                    return a[key].localeCompare(b[key]) * dir;
                }
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

            data.forEach((student, index) => {
                appendStudentRow(student, index);
            });
        }

        function appendStudentRow(student, index) {
            const tbody = document.getElementById('tableBody');
            const rowId = \`detail-\${student.regno}\`; // Unique ID based on Regno

            // Determine Grade Color for SGPA
            let sgpaColor = "bg-gray-100 text-gray-800";
            let val = parseFloat(student.sgpa);
            if(val >= 9) sgpaColor = "bg-green-100 text-green-800";
            else if(val >= 8) sgpaColor = "bg-blue-100 text-blue-800";
            else if(val >= 6) sgpaColor = "bg-yellow-100 text-yellow-800";
            else if(val > 0 && val < 6) sgpaColor = "bg-red-100 text-red-800";

            const tr = document.createElement('tr');
            tr.className = "hover:bg-gray-50 transition-colors cursor-pointer border-b border-gray-100 fade-in";
            tr.onclick = () => toggleDetails(rowId);
            
            tr.innerHTML = \`
                <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500">\${index + 1}</td>
                <td class="px-6 py-4 whitespace-nowrap font-medium text-gray-900">\${student.name}</td>
                <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500 font-mono">\${student.regno}</td>
                <td class="px-6 py-4 whitespace-nowrap">
                    <span class="px-2.5 py-1 inline-flex text-xs leading-5 font-bold rounded-full \${sgpaColor}">
                        \${student.sgpa}
                    </span>
                </td>
                <td class="px-6 py-4 whitespace-nowrap text-sm text-blue-500 hover:text-blue-700">View Details</td>
            \`;
            tbody.appendChild(tr);

            // Detailed Row (Hidden by default)
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
                    </div>
                \`;
            }).join('');

            detailTr.innerHTML = \`<td colspan="5" class="px-6 py-4"><div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">\${subjectsHtml}</div></td>\`;
            tbody.appendChild(detailTr);
        }

        function toggleDetails(id) {
            const el = document.getElementById(id);
            el.style.display = (el.style.display === "table-row") ? "none" : "table-row";
        }

        function downloadJSON() {
            const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(allStudents, null, 2));
            const downloadAnchorNode = document.createElement('a');
            downloadAnchorNode.setAttribute("href", dataStr);
            downloadAnchorNode.setAttribute("download", "final_results_data.json");
            document.body.appendChild(downloadAnchorNode);
            downloadAnchorNode.click();
            downloadAnchorNode.remove();
        }
    </script>
</body>
</html>
`;

// ================== 3. THE SERVER (Routes) ==================

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
    console.log(`\n🚀 DASHBOARD READY!`);
    console.log(`👉 http://localhost:${PORT}`);
});