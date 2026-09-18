const fs = require('fs');
const zlib = require('zlib');
const sess = '/home/ggbond/.dsh/sessions';
function frames(f) {
  const buf = fs.readFileSync(f);
  const offs = [];
  for (let i = 0; i <= buf.length - 4; i++) { if (buf[i] === 0x28 && buf[i + 1] === 0xB5 && buf[i + 2] === 0x2F && buf[i + 3] === 0xFD) { offs.push(i); i += 3; } }
  const out = [];
  for (let k = 0; k < offs.length; k++) { const end = k + 1 < offs.length ? offs[k + 1] : buf.length; try { out.push(zlib.zstdDecompressSync(buf.subarray(offs[k], end)).toString('utf8')); } catch (_) {} }
  return out;
}
// 只扫纯旧格式目录（无 v3），对比 chunk 口径与 message 口径的 tokens 总量
let chunkTokens = 0, chunkReqs = 0, msgTokens = 0, msgReqs = 0, msgWithUsage = 0, msgNoUsage = 0, officialMsgs = 0;
for (const proj of fs.readdirSync(sess)) {
  const pd = sess + '/' + proj; let s1; try { s1 = fs.statSync(pd); } catch (_) { continue; } if (!s1.isDirectory()) continue;
  for (const s of fs.readdirSync(pd)) {
    const sd = pd + '/' + s; let s2; try { s2 = fs.statSync(sd); } catch (_) { continue; } if (!s2.isDirectory()) continue;
    if (fs.existsSync(sd + '/session.v3.jsonl.zstd')) continue; // 纯旧格式
    const f = sd + '/session.jsonl.zstd'; if (!fs.existsSync(f)) continue;
    const groups = {}; // turn:step -> usage
    const msgByGroup = {}; // turn:step -> usage (from message)
    for (const chunk of frames(f)) {
      for (const line of chunk.split('\n')) {
        const t = line.trim(); if (!t) continue;
        let e; try { e = JSON.parse(t); } catch (_) { continue; }
        if (e.type === 'assistant/chunk' && e.data && e.data.chunk && e.data.chunk.type === 'usage' && e.data.chunk.usage) {
          const key = e.data.turn + ':' + e.data.step;
          groups[key] = e.data.chunk.usage;
        } else if (e.type === 'assistant/message' && e.data) {
          const key = e.data.turn + ':' + e.data.step;
          const msg = e.data.message || {};
          const prov = (msg.source && msg.source.provider) || null;
          if (prov !== 'deepseek-official') continue;
          officialMsgs++;
          const u = e.data.usage;
          if (u) { msgByGroup[key] = u; msgWithUsage++; } else msgNoUsage++;
        }
      }
    }
    for (const k in groups) {
      const u = groups[k];
      chunkTokens += u.totalTokens || (u.inputTokens + u.outputTokens + (u.cacheReadTokens || 0));
      chunkReqs++;
    }
    for (const k in msgByGroup) {
      const u = msgByGroup[k];
      msgTokens += u.totalTokens || (u.inputTokens + u.outputTokens + (u.cacheReadTokens || 0));
      msgReqs++;
    }
  }
}
console.log('旧格式(纯): chunk口径 tokens=' + chunkTokens.toLocaleString() + ' reqs=' + chunkReqs);
console.log('旧格式(纯): message口径(官方) tokens=' + msgTokens.toLocaleString() + ' reqs=' + msgReqs);
console.log('旧格式(纯): 官方message带usage=' + msgWithUsage + ' 无usage=' + msgNoUsage);
