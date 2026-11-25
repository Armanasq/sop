import { NotionAPI } from 'notion-client'
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'

const ROOT = 'df39955313834889b7ac5411c37b958d'
const BASE = 'https://cs-sop.notion.site/'
const MAX_BYTES = 20 * 1024 * 1024
const CONCURRENCY = Number(process.env.SOP_WORKERS || '6')
const root = process.cwd()
const clean = s => String(s ?? '').replace(/\s+/g, ' ').trim()
const slug = s => clean(s).normalize('NFKD').replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 110) || 'unknown'
const hash = b => createHash('sha256').update(b).digest('hex')
const flat = v => typeof v === 'string' ? v : Array.isArray(v) ? v.map(flat).join(' ') : v && typeof v === 'object' ? Object.values(v).map(flat).join(' ') : ''
const quote = v => '"' + String(v ?? '').replace(/"/g, '""') + '"'
function linksIn(v, out = new Set()) {
  if (typeof v === 'string') {
    for (const m of v.matchAll(/https?:\/\/[^\s"'<>]+/g)) out.add(m[0].replace(/[),.;]+$/, ''))
  } else if (Array.isArray(v)) {
    for (const x of v) linksIn(x, out)
  } else if (v && typeof v === 'object') {
    for (const x of Object.values(v)) linksIn(x, out)
  }
  return [...out]
}
function prioritize(url) {
  return /drive\.google\.com|docs\.google\.com|dropbox\.com|1drv\.ms|onedrive\.live\.com|\.pdf(?:\?|$)|\.docx?(?:\?|$)|amazonaws\.com|notion-static\.com/i.test(url) ? 5 : 0
}
function downloadUrl(url) {
  let m = url.match(/drive\.google\.com\/file\/(?:u\/\d+\/)?d\/([\w-]+)/)
  if (m) return 'https://drive.usercontent.google.com/download?id=' + m[1] + '&export=download&confirm=t'
  m = url.match(/drive\.google\.com\/(?:open|uc)\?[^#]*\bid=([\w-]+)/)
  if (m) return 'https://drive.usercontent.google.com/download?id=' + m[1] + '&export=download&confirm=t'
  m = url.match(/docs\.google\.com\/(document|spreadsheets|presentation)\/d\/([\w-]+)/)
  if (m) return 'https://docs.google.com/' + m[1] + '/d/' + m[2] + '/export?format=pdf'
  if (/dropbox\.com/.test(url)) return url.replace(/[?&]dl=[01]/, '').replace(/[?&]raw=[01]/, '') + (url.includes('?') ? '&' : '?') + 'dl=1'
  if (/github\.com\/.+\/blob\//.test(url)) return url.replace('github.com/', 'raw.githubusercontent.com/').replace('/blob/', '/')
  return url
}
async function fetchSop(url) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 45000)
  try {
    const res = await fetch(downloadUrl(url), {signal:controller.signal,headers:{'user-agent':'Mozilla/5.0 (compatible; SOP-Archive/1.0)',accept:'application/pdf,application/octet-stream,*/*'}})
    if (!res.ok) throw Error('HTTP ' + res.status)
    const declared = Number(res.headers.get('content-length') || 0)
    if (declared > MAX_BYTES) throw Error('Too large: ' + declared)
    const bytes = Buffer.from(await res.arrayBuffer())
    if (bytes.length > MAX_BYTES) throw Error('Too large: ' + bytes.length)
    if (bytes.subarray(0,5).toString() === '%PDF-') return {bytes,ext:'pdf'}
    if (bytes.subarray(0,2).toString() === 'PK') return {bytes,ext:'docx'}
    throw Error('Not PDF/DOCX: ' + res.headers.get('content-type') + '; final=' + res.url)
  } finally {clearTimeout(timer)}
}
async function mapLimit(items, limit, fn) {
  let position = 0
  const results = new Array(items.length)
  await Promise.all(Array.from({length:Math.min(limit,items.length)}, async ()=>{
    while (position < items.length) {
      const i = position++
      try {results[i] = await fn(items[i],i)} catch(e) {results[i] = {error:String(e)}}
    }
  }))
  return results
}
async function fetchRoot() {
  let last
  for (const apiBaseUrl of ['https://cs-sop.notion.site/api/v3','https://www.notion.so/api/v3']) {
    try {
      const api = new NotionAPI({apiBaseUrl})
      const page = await api.getPage(ROOT,{concurrency:3,fetchCollections:true,signFileUrls:false})
      if (!page?.block || Object.keys(page.block).length < 30) throw Error('Root record map unexpectedly small')
      console.log('Notion root read',apiBaseUrl,'blocks',Object.keys(page.block).length,'collections',Object.keys(page.collection||{}).length)
      return {api,page}
    } catch(e) {last=e;console.error('Notion endpoint failed',apiBaseUrl,String(e).slice(0,500))}
  }
  throw last
}
async function prior2025() {
  try {
    const txt = await readFile('2025/index.csv','utf8')
    const names = new Set()
    for (const line of txt.split(/\r?\n/).slice(1)) {
      const m = line.match(/^"([^"]+)"/)
      if (m) names.add(m[1].replaceAll('""','"'))
    }
    return names
  } catch {return new Set()}
}
function propertiesFor(page,collectionMap) {
  const c=collectionMap[page.parent_id];const schema=(c?.value?.value || c?.value || c)?.schema || {}
  const props = {}
  for (const [key,value] of Object.entries(page.properties||{})) {
    const label = schema[key]?.name || key
    props[label] = {text:clean(flat(value)),urls:linksIn(value)}
  }
  return props
}
function getYear(props,known2025,name) {
  for (const [k,v] of Object.entries(props)) {
    if (/(^year$|application.?year|application.?cycle)/i.test(k)) {
      const match = v.text.match(/(?:19|20)\d{2}/)
      if (match) return match[0]
    }
  }
  if (known2025.has(name)) return '2025'
  return 'unclassified'
}
function urlsForRecord(p,rm) {
  const all = []
  const ordered = Object.entries(p).sort((a,b)=> (/(statement|sop|purpose|intent|file|pdf|document|application)/i.test(b[0])?1:0) - (/(statement|sop|purpose|intent|file|pdf|document|application)/i.test(a[0])?1:0))
  for (const [name,obj] of ordered) for (const url of obj.urls||[]) all.push([url,name])
  for (const url of linksIn(rm.block||{})) all.push([url,'page_block'])
  for (const url of Object.values(rm.signed_urls||{})) if (typeof url === 'string') all.push([url,'notion_attachment'])
  const seen = new Set()
  return all.filter(([url])=>{if (!/^https?:\/\//.test(url) || seen.has(url)) return false;seen.add(url);return true}).sort((a,b)=>prioritize(b[0])-prioritize(a[0]))
}
const HEADER=['name','institution','field','notion_entry','statement_url','file','status','sha256','notes']
const idOf = value => String(value||'').match(/[a-f0-9]{32}(?=$|[?#/])/i)?.[0]?.toLowerCase()
function parseCsv(text) {
  const records=[]; let row=[],field='',quoted=false
  for(let i=0;i<text.length;i++){
    const c=text[i]
    if(quoted){if(c==='"'&&text[i+1]==='"'){field+='"';i++}else if(c==='"')quoted=false;else field+=c}
    else if(c==='"'&&field==='')quoted=true
    else if(c===','){row.push(field);field=''}
    else if(c==='\n'){row.push(field.replace(/\r$/,''));records.push(row);row=[];field=''}
    else field+=c
  }
  if(quoted)throw Error('Unterminated CSV quote')
  if(row.length||field){row.push(field.replace(/\r$/,''));records.push(row)}
  const keys=records.shift()||[]
  return records.filter(r=>r.some(Boolean)).map(r=>{
    if(r.length!==keys.length)throw Error('Invalid CSV field count: '+r[0])
    return Object.fromEntries(keys.map((k,i)=>[k,r[i]]))
  })
}
async function loadPrior(){
  const prior=new Map()
  for(const entry of await readdir(root,{withFileTypes:true})){
    if(!entry.isDirectory()||!/^(?:\d{4}|unclassified)$/.test(entry.name))continue
    let text;try{text=await readFile(path.join(entry.name,'index.csv'),'utf8')}catch(e){if(e.code==='ENOENT')continue;throw e}
    for(const r of parseCsv(text)){
      const id=idOf(r.notion_entry)
      const key=id||entry.name+':'+r.name
      if(prior.has(key))throw Error('Duplicate existing record: '+key)
      prior.set(key,{...r,year:entry.name,notion:r.notion_entry})
    }
  }
  return prior
}
function validDoc(bytes,ext){
  if(ext==='pdf')return bytes.subarray(0,5).toString()==='%PDF-'
  if(ext==='docx')return bytes.subarray(0,2).toString()==='PK'&&bytes.includes(Buffer.from('[Content_Types].xml'))&&bytes.includes(Buffer.from('word/document.xml'))
  return false
}
async function existingRecord(r){
  if(!r?.file)return null
  if(!/^(?:\d{4}|unclassified)\/files\/[^/\\]+$/i.test(r.file))throw Error('Unexpected archive path: '+r.file)
  let bytes;try{bytes=await readFile(r.file)}catch(e){if(e.code==='ENOENT')return null;throw e}
  if(!validDoc(bytes,path.extname(r.file).slice(1).toLowerCase()))throw Error('Invalid archived file: '+r.file)
  const sha256=hash(bytes)
  if(r.sha256&&r.sha256!==sha256)throw Error('Archived checksum mismatch: '+r.file)
  return {...r,sha256,status:'already_archived'}
}
function oldLinks(r){
  return [r?.statement_url,...linksIn(r?.notes||'').filter(u=>/\.pdf(?:\?|$)|drive\.google\.com\/file\/|docs\.google\.com\/document\//i.test(u))]
    .filter(Boolean)
}
function safeLink(url){
  try{const u=new URL(url);if(!['http:','https:'].includes(u.protocol)||u.username||u.password)return '';return u.href}catch{return ''}
}
async function recover(row,urls,override){
  const direct=override?.kind==='pdf'?[override.url]:[]
  const seen=new Set()
  const candidates=[...direct,...urls].map(safeLink).filter(u=>u&&!seen.has(u)&&seen.add(u)).filter(u=>!/\b(?:resume|curriculum[_-]?vitae|transcript|cv)\.pdf(?:\?|$)/i.test(u))
  const failures=[]
  for(const url of candidates.slice(0,8)){
    try{
      const {bytes,ext}=await fetchSop(url)
      if(!validDoc(bytes,ext))throw Error('Invalid document signature')
      const dir=path.join(row.year,'files')
      await mkdir(dir,{recursive:true})
      let dest=path.join(dir,slug(row.name)+'.'+ext)
      try{
        const existing=await readFile(dest)
        if(hash(existing)!==hash(bytes))dest=path.join(dir,slug(row.name)+'_'+(idOf(row.notion)||hash(bytes).slice(0,12))+'.'+ext)
      }catch(e){if(e.code!=='ENOENT')throw e}
      try{await writeFile(dest,bytes,{flag:'wx'})}catch(e){
        if(e.code!=='EEXIST'||hash(await readFile(dest))!==hash(bytes))throw e
      }
      return {...row,file:dest,statement_url:url,sha256:hash(bytes),status:'downloaded',notes:'',links:candidates}
    }catch(e){
      const u=new URL(url);failures.push(u.origin+u.pathname.slice(0,150)+': '+String(e).split('; final=')[0].slice(0,130))
    }
  }
  return {...row,file:'',sha256:'',status:'unresolved',statement_url:override?.url||row.statement_url||'',notes:[row.notes,override?.kind==='web'?'Author-hosted statement available as a web reference; no original binary verified.':'',...failures].filter(Boolean).join(' | ').slice(0,1600)}
}
async function main(){
  const prior=await loadPrior()
  let previousStatus={}
  try{previousStatus=JSON.parse(await readFile('SYNC_STATUS.json','utf8'))}catch(e){if(e.code!=='ENOENT')throw e}
  const sources=JSON.parse(await readFile('RECOVERY_SOURCES.json','utf8'))
  const overrides=new Map(sources.records.map(r=>[r.notion_id,r]))
  let api,page,scanError=''
  try{({api,page}=await fetchRoot())}catch(e){scanError=String(e).slice(0,350);if(!prior.size)throw e}
  const collection=page?.collection||{}
  const allBlocks=Object.values(page?.block||{}).map(x=>x?.value?.value?.type?x.value.value:x?.value?.type?x.value:x).filter(Boolean)
  let discovered=allBlocks.filter(x=>x?.type==='page'&&x?.properties?.title&&x.id?.replaceAll('-','')!==ROOT)
  discovered=[...new Map(discovered.map(p=>[p.id.replaceAll('-',''),p])).values()].filter(p=>{const n=clean(flat(p.properties.title));return n&&!/^untitled$/i.test(n)})
  if(discovered.length<20){scanError=scanError||'Source listing too small: '+discovered.length;discovered=[];if(!prior.size)throw Error(scanError)}
  const byId=new Map(discovered.map(p=>[p.id.replaceAll('-',''),p]))
  const keys=[...new Set([...prior.keys(),...byId.keys()])]
  const known2025=await prior2025()
  const rows=await mapLimit(keys,CONCURRENCY,async id=>{
    const old=prior.get(id)
    const p=byId.get(id)
    const retained=await existingRecord(old)
    if(retained)return retained
    const props=p?propertiesFor(p,collection):{}
    const name=p?clean(flat(p.properties.title)):old?.name
    const year=old?.year||getYear(props,known2025,name)
    const row={name,year,institution:old?.institution||Object.entries(props).filter(([k])=>/institution|university|school|attend/i.test(k)).map(([,v])=>v.text).join('; '),field:old?.field||Object.entries(props).filter(([k])=>/field|subfield|area|research/i.test(k)).map(([,v])=>v.text).join('; '),notion:old?.notion||BASE+slug(name).replaceAll('_','-')+'-'+id,statement_url:old?.statement_url||'',file:'',status:'unresolved',sha256:'',notes:''}
    let rm={block:{},signed_urls:{}}
    if(api&&p){try{rm=await api.getPage(p.id,{fetchCollections:false,signFileUrls:true})}catch(e){row.notes=String(e).slice(0,180)}}
    const urls=urlsForRecord(props,rm)
    const candidates=urls.filter(([u])=>prioritize(u)>0)
    const linked=(candidates.length?candidates:urls.filter(([,label])=>/(statement|sop|purpose|intent|file|document)/i.test(label))).map(([u])=>u)
    const result=await recover(row,[...linked,...oldLinks(old)],overrides.get(id))
    if(result.status==='unresolved'&&!result.notes)result.notes='No public document link discovered'
    return result
  })
  const errors=rows.flatMap((r,i)=>r?.error?[{id:keys[i],error:r.error}]:[])
  if(errors.length)throw Error('Record processing failed; refusing index overwrite: '+JSON.stringify(errors))
  const all=rows.filter(r=>r?.name)
  const years=[...new Set(all.map(r=>r.year))].sort((a,b)=>b.localeCompare(a))
  let documentCount=0
  const counts={}
  for(const year of years){
    const entries=all.filter(r=>r.year===year).sort((a,b)=>a.name.localeCompare(b.name))
    const dir=path.join(year,'files')
    await mkdir(dir,{recursive:true})
    const files=(await readdir(dir,{withFileTypes:true})).filter(f=>f.isFile()&&/\.(pdf|docx)$/i.test(f.name))
    documentCount+=files.length
    counts[year]={records:entries.length,downloaded:entries.filter(r=>r.status==='downloaded').length,already_archived:entries.filter(r=>r.status==='already_archived').length,unresolved:entries.filter(r=>r.status==='unresolved').length,archived_files:files.length}
    const lines=[HEADER.join(','),...entries.map(r=>[r.name,r.institution,r.field,r.notion,r.statement_url,r.file,r.status,r.sha256,r.notes].map(quote).join(','))]
    await writeFile(year+'/index.csv',lines.join('\n')+'\n')
  }
  const status={...previousStatus,run_utc:new Date().toISOString(),total:all.length,source_scan_records:discovered.length,source_scan_error:scanError||null,source_scan_complete:!scanError&&discovered.length>=prior.size,years:counts,total_downloaded_documents:documentCount,records_with_archived_documents:all.filter(r=>r.status!=='unresolved').length,unresolved_records:all.filter(r=>r.status==='unresolved').length,errors}
  await writeFile('SYNC_STATUS.json',JSON.stringify(status,null,2)+'\n')
  console.log(JSON.stringify(status,null,2))
}
main().catch(e=>{console.error(e);process.exitCode=1})
