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
  const schema = (collectionMap[page.parent_id]?.value || collectionMap[page.parent_id])?.schema || {}
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
async function main() {
  const {api,page} = await fetchRoot()
  const known2025 = await prior2025()
  const allBlocks = Object.values(page.block).map(x=>x?.value?.type ? x.value : x).filter(Boolean)
  console.log('First block keys',Object.keys(allBlocks[0]||{}),'first',JSON.stringify(allBlocks[0]).slice(0,300))
  console.log('Block kinds',Object.entries(allBlocks.reduce((a,x)=>{const k=x.type+'|'+x.parent_table;a[k]=(a[k]||0)+1;return a},{})).sort((a,b)=>b[1]-a[1]).slice(0,18))
  console.log('Titled examples',allBlocks.filter(x=>x.properties?.title).slice(-10).map(x=>({type:x.type,parent:x.parent_table,parent_id:x.parent_id,title:clean(flat(x.properties.title)).slice(0,70)})))
  const pages = allBlocks.filter(x=>x?.type==='page' && x?.properties?.title && x.id?.replaceAll('-','')!==ROOT)
  const uniq = [...new Map(pages.map(p=>[p.id,p])).values()]
  if (uniq.length < 20) throw Error('Only ' + uniq.length + ' collection rows: refusing partial sync')
  console.log('Collection rows',uniq.length,'2025 fallback rows',known2025.size)
  const collection = page.collection||{}
  const rows = await mapLimit(uniq,CONCURRENCY,async p=>{
    const properties=propertiesFor(p,collection)
    const name=clean(flat(p.properties.title))
    const year=getYear(properties,known2025,name)
    let rm={block:{},signed_urls:{}}
    let err=''
    try {rm=await api.getPage(p.id,{fetchCollections:false,signFileUrls:true})} catch(e) {err=String(e).slice(0,180)}
    const urls=urlsForRecord(properties,rm)
    const candidates=urls.filter(([url])=>prioritize(url)>0)
    const linked=candidates.length?candidates:urls.filter(([url,label])=>/(statement|sop|purpose|intent|file|document)/i.test(label))
    const institution=Object.entries(properties).filter(([key])=>/institution|university|school|attend/i.test(key)).map(([,v])=>v.text).join('; ')
    const field=Object.entries(properties).filter(([key])=>/field|subfield|area|research/i.test(key)).map(([,v])=>v.text).join('; ')
    const notion=BASE+slug(name).replaceAll('_','-')+'-'+p.id.replaceAll('-','')
    const row={name,year,institution,field,notion,statement_url:'',file:'',status:'unresolved',sha256:'',notes:err,links:linked.map(([url])=>url)}
    const dir=path.join(root,year,'files')
    await mkdir(dir,{recursive:true})
    const prefix=slug(name).toLowerCase()
    const files=(await readdir(dir)).filter(f=>f.toLowerCase().startsWith(prefix+'_') || f.toLowerCase()===prefix+'.pdf' || f.toLowerCase()===prefix+'.docx')
    if (files.length){row.file=year+'/files/'+files[0];row.status='already_archived';row.statement_url=linked[0]?.[0]||'';return row}
    for (const [url] of linked.slice(0,8)) {
      try {
        const {bytes,ext}=await fetchSop(url)
        const file=year+'/files/'+slug(name)+'.'+ext
        await writeFile(file,bytes)
        row.file=file;row.sha256=hash(bytes);row.status='downloaded';row.statement_url=url;row.notes=''
        break
      } catch(e) {row.notes=(row.notes+' | '+url.slice(0,120)+': '+String(e).slice(0,120)).slice(0,950)}
    }
    if (row.status==='unresolved' && !linked.length)row.notes=(row.notes+' | No document link discovered').trim()
    return row
  })
  const all=rows.filter(x=>x?.name)
  const years=[...new Set(all.map(r=>r.year))].sort((a,b)=>b.localeCompare(a))
  for (const year of years) {
    const entries=all.filter(r=>r.year===year).sort((a,b)=>a.name.localeCompare(b.name))
    await mkdir(year,{recursive:true})
    const header=['name','institution','field','notion_entry','statement_url','file','status','sha256','notes']
    const lines=[header.join(','),...entries.map(r=>[r.name,r.institution,r.field,r.notion,r.statement_url,r.file,r.status,r.sha256,r.notes].map(quote).join(','))]
    await writeFile(year+'/index.csv',lines.join('\n')+'\n')
  }
  const status={run_utc:new Date().toISOString(),total:all.length,years:Object.fromEntries(years.map(y=>[y,{records:all.filter(r=>r.year===y).length,downloaded:all.filter(r=>r.year===y && r.status==='downloaded').length,already_archived:all.filter(r=>r.year===y && r.status==='already_archived').length,unresolved:all.filter(r=>r.year===y && r.status==='unresolved').length}])),errors:rows.filter(x=>x?.error).slice(0,20)}
  await writeFile('SYNC_STATUS.json',JSON.stringify(status,null,2)+'\n')
  console.log(JSON.stringify(status,null,2))
  if (all.length<20) throw Error('Too few entries; refusing success')
}
main().catch(e=>{console.error(e);process.exitCode=1})
