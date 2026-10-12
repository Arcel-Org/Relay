// Decide whether the /app reload-blank is real with data present.
// Sign up 2 users, add contact, exchange E2E messages, then HARD reload A.
const { chromium } = await import('@playwright/test');
import { TOTP, Secret } from 'otpauth';
import { createHash } from 'crypto';

const APP_URL = 'https://localhost:3020';
const PIN = '741852';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const testIp = (l) => { const h = createHash('sha256').update('rlk:'+l).digest(); return `10.${h[0]}.${h[1]}.${h[2]}`; };
function computeTotp(b32){ return new TOTP({ secret: Secret.fromBase32(b32.replace(/\s/g,'')), digits:6, period:30 }).generate(); }
async function click(page, loc){ for(let i=0;i<10;i++){ try{ await loc.waitFor({state:'visible',timeout:15000}); await loc.click({timeout:5000}); return; }catch(e){ await sleep(700);} } await loc.click({timeout:10000}); }
async function fill(page, sel, v){ for(let i=0;i<10;i++){ try{ await page.locator(sel).waitFor({state:'visible',timeout:15000}); await page.locator(sel).fill(v,{timeout:5000}); return; }catch(e){ await sleep(700);} } await page.locator(sel).fill(v,{timeout:10000}); }
async function enterPinKeypad(page, pin){ for(const d of pin.split('')){ await click(page, page.getByRole('button',{name:`Digit ${d}`,exact:true})); await sleep(100);} }
async function signup(page){
  await page.goto(`${APP_URL}/auth/landing`);
  await click(page, page.getByText('Create new identity'));
  await sleep(800);
  await click(page, page.getByText('Authenticator App'));
  await sleep(800);
  await click(page, page.getByText("Can't scan? Enter manually")).catch(()=>{});
  const secret = (await page.textContent('body'))?.match(/[A-Z2-7]{16,64}/)?.[0];
  await fill(page, 'input[placeholder="000000"]', computeTotp(secret));
  await click(page, page.getByText('Verify & Continue'));
  await sleep(1000);
  await enterPinKeypad(page, PIN); await click(page, page.locator('button:has-text("✓")')); await sleep(500);
  await enterPinKeypad(page, PIN); await click(page, page.locator('button:has-text("✓")')); await sleep(1500);
  await click(page, page.getByText('I have saved my recovery code in a secure location'));
  await click(page, page.getByText('Continue to App'));
  await sleep(2000);
  await click(page, page.getByText('Get started'));
  await click(page, page.getByText('Next')).catch(()=>{});
  await click(page, page.getByText('Open Messenger')).catch(()=>{});
  await sleep(1200);
}
async function getOwnRelayId(page){ await click(page, page.locator('[title="Account Settings"]')); const m=(await page.textContent('body'))?.match(/[0-9a-f]{4}(?:-[0-9a-f]{4}){7}/); await click(page, page.locator('[title="Close"]')); await sleep(300); return m[0]; }
async function addContact(page, relayId){
  async function openComposer(){ const t=['text=Add First Contact','[title="Start new conversation"]','[title="New conversation"]','button:has-text("New Message")']; for(const sel of t){ const loc=page.locator(sel).first(); if(await loc.count().catch(()=>0)){ await click(page,loc).catch(()=>{}); await sleep(900);} if(await page.locator('#add-contact-input').count().catch(()=>0)) return true;} return await page.locator('#add-contact-input').count().catch(()=>0)>0; }
  await page.waitForSelector('textarea[placeholder="Message..."]',{timeout:15000}).catch(()=>{});
  let open=await openComposer();
  await fill(page,'#add-contact-input',relayId);
  const confirm=page.getByRole('button',{name:'Add Contact',exact:true});
  for(let i=0;i<20;i++){ if(await confirm.isEnabled().catch(()=>false)) break; await sleep(500);} await click(page,confirm); await sleep(700);
}
async function openConv(page, name, id){ try{ const loc=page.getByRole('button').filter({hasText:name}).first(); if(await loc.count()) await click(page,loc); }catch{} await sleep(600); }
async function sendMsg(page, text){ await fill(page,'textarea[placeholder="Message..."]',text); await click(page,page.locator('[aria-label="Send message"]')); await sleep(500); }

const browser = await chromium.launch({headless:true});
const ctxA = await browser.newContext({viewport:{width:1440,height:900},ignoreHTTPSErrors:true,extraHTTPHeaders:{'X-Real-IP':testIp('A')}});
const ctxB = await browser.newContext({viewport:{width:1440,height:900},ignoreHTTPSErrors:true,extraHTTPHeaders:{'X-Real-IP':testIp('B')}});
const pA = await ctxA.newPage(), pB = await ctxB.newPage();
const errs=[], cons=[];
pA.on('pageerror', e=>errs.push('A: '+String(e)));
pA.on('console', m=>{ if(m.type()==='error') cons.push('A: '+m.text()); });

console.log('signup A,B...');
await signup(pA); await signup(pB);
const idA=await getOwnRelayId(pA), idB=await getOwnRelayId(pB);
console.log('ids', idA.slice(0,8), idB.slice(0,8));
console.log('add contact A->B...');
await addContact(pA, idB);
await addContact(pB, idA);
console.log('exchange messages...');
await pA.waitForSelector('textarea[placeholder="Message..."]',{timeout:15000}).catch(()=>{});
await openConv(pA, idB, idB);
await pA.waitForSelector('textarea[placeholder="Message..."]',{timeout:15000}).catch(()=>{});
await sendMsg(pA,'hello, this is encrypted');
await sleep(1200);
await openConv(pA, idB, idB);
await sendMsg(pA,'persisted app state exists now');
await sleep(1500);

async function blank(tag){
  const s = await pA.evaluate(()=>{ const el=document.body; return { url:location.href, title:document.title, children:el?el.children.length:-1, text:(el&&el.innerText||'').trim().length, html:(el&&el.innerHTML||'').length }; });
  console.log(`[${tag}] url=${s.url} bodyChildren=${s.children} textLen=${s.text} htmlLen=${s.html}`);
}
await blank('live A (has data)');
console.log('HARD RELOAD A ...');
await pA.goto(`${APP_URL}/app`,{waitUntil:'domcontentloaded'}).catch(()=>{});
await sleep(6000);
await blank('A goto-reload');
await pA.reload({waitUntil:'domcontentloaded'}).catch(()=>{});
await sleep(5000);
await blank('A reload()');

console.log('=== page errors ===');
errs.forEach(e=>console.log('  '+e.slice(0,400)));
console.log('=== console errors ===');
cons.forEach(c=>console.log('  '+c.slice(0,300)));
await pA.screenshot({path:'/tmp/reload-data-final.png'}).catch(()=>{});
await browser.close();
