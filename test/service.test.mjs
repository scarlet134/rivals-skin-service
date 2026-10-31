import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { createSkinServer, parseOptions } from '../server.mjs';
import { renderSkin } from '../renderer.mjs';
const parse = q => parseOptions(new URL('http://localhost/skin.png?' + q));
let source;
async function fixture() {
  source ??= await sharp({create:{width:256,height:128,channels:4,background:{r:150,g:170,b:190,alpha:1}}}).png().toBuffer();
  return source;
}
test('query validation and canonical colors', () => {
  assert.equal(parse('name=pinky').name, 'pinky');
  assert.deepEqual(parse('name=default&custom=1&body=5498880&feet=3079936'),{name:'default',custom:true,body:5498880,feet:3079936});
  for(const q of ['name=..','name=../foo','name=https://test.com','name=%00','custom=2','custom=1','body=-1','feet=16777216','name=a&name=b','url=https://test.com']) assert.throws(()=>parse(q));
});
test('512px PNG and DDNet recoloring',async()=>{
  const buf=await fixture();const original=await renderSkin(buf);const custom=await renderSkin(buf,{custom:true,body:0,feet:65535});
  const meta=await sharp(custom).metadata(); assert.equal(meta.width,512);assert.equal(meta.height,512);assert.equal(meta.format,'png');assert.equal(meta.hasAlpha,true);
  assert.notDeepEqual(original,custom);const {data}=await sharp(custom).raw().toBuffer({resolveWithObject:true});assert.equal(data[3],0);
  await assert.rejects(()=>renderSkin(Buffer.from('invalid')));
  await assert.rejects(async()=>renderSkin(await sharp({create:{width:64,height:64,channels:4,background:'red'}}).png().toBuffer()));
});
test('HTTP PNG, caching, HEAD, safety and missing skin',async(t)=>{
  let loads=0;const server=createSkinServer({loadSkin:async name=>{ loads++;if(name==='missing'){const e=new Error('Skin not found');e.status=404;throw e;}return fixture();}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>server.close());const base='http://127.0.0.1:'+server.address().port;
  assert.equal((await fetch(base+'/health')).status,200);
  const r=await fetch(base+'/skin.png?name=default');assert.equal(r.status,200);assert.equal(r.headers.get('content-type'),'image/png');assert.ok((await r.arrayBuffer()).byteLength>100);
  const etag=r.headers.get('etag');assert.ok(etag);
  assert.equal((await fetch(base+'/skin.png?name=default',{headers:{'if-none-match':etag}})).status,304);
  const head=await fetch(base+'/skin.png?name=default',{method:'HEAD'});assert.equal(head.status,200);assert.equal((await head.arrayBuffer()).byteLength,0);assert.equal(loads,1);
  assert.equal((await fetch(base+'/skin.png?name=default',{method:'POST'})).status,405);
  assert.equal((await fetch(base+'/skin.png?name=..')).status,400);
  assert.equal((await fetch(base+'/skin.png?name=missing')).status,404);
  assert.equal((await fetch(base+'/foo')).status,404);
});
