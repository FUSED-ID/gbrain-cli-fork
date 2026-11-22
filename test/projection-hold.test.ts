import {expect,test} from 'bun:test';
import {PGLiteEngine} from '../src/core/pglite-engine.ts';
import {runResidentProjectionInvocation} from '../src/core/persistence/consumer.ts';
import {importFromContent} from '../src/core/import-file.ts';
import {installFaultHook} from '../src/core/persistence/fault-points.ts';
import {conversationBody} from './helpers/conversation-page.ts';
import {randomUUID} from 'node:crypto';

test('resident excludes held inline and segmented projections, processes ordinary work and resumes both after the hold',async()=>{
 const engine=new PGLiteEngine();
 await engine.connect({}); await engine.initSchema();
 await engine.setConfig("pages.segmented_storage","on");
 const held='fused-id-infrastructure',host=randomUUID();
 const prior=process.env.GBRAIN_WORKER_HELD_SOURCE;
 try{
  await engine.executeRaw("insert into sources(id,name) values($1,'Held fixture')",[held]);
  for (const source of [held,'default']){
   await engine.putPage('fixture/inline',{type:'concept',title:'Fixture',compiled_truth:'sample'},{sourceId:source});
   installFaultHook(point=>{if(point==='segmented:projection_staged')throw Error('fixture leaves projection pending')});
   try {
    const content='---\ntitle: Group chat\ntype: note\n---\n\n'+conversationBody(4*1024*1024+256*1024,{seed:11})+'\n';
    const result=await importFromContent(engine,'fixture/segmented',content,{sourceId:source,noEmbed:true});
    expect(result.searchable).toBe('pending');
   }finally{installFaultHook(undefined);}
  }
  const rows=(source:string)=>engine.executeRaw("select slug,body_storage,text_projection_revision is not distinct from knowledge_revision as sealed from pages where source_id=$1 order by slug",[source]);
  const pending=(source:string)=>engine.executeRaw("select j.* from page_projection_jobs j join sources s on s.incarnation=j.source_incarnation where s.id=$1 order by j.slug",[source]);
  const before=await rows(held), queue=await pending(held);
  expect(before.map(p=>p.sealed)).toEqual([false,false]);expect(before[1].body_storage).toBe('segmented');expect(queue.length).toBe(2);
  process.env.GBRAIN_WORKER_HELD_SOURCE=held;
  await runResidentProjectionInvocation(engine,host,[],()=>0);
  expect(await rows(held)).toEqual(before);expect(await pending(held)).toEqual(queue);
  expect((await rows('default')).map(p=>p.sealed)).toEqual([true,true]);
  delete process.env.GBRAIN_WORKER_HELD_SOURCE;
  await runResidentProjectionInvocation(engine,host,[],()=>0);
  expect((await rows(held)).map(p=>p.sealed)).toEqual([true,true]);expect(await pending(held)).toHaveLength(0);
 }finally{
  installFaultHook(undefined);
  if(prior===undefined)delete process.env.GBRAIN_WORKER_HELD_SOURCE;else process.env.GBRAIN_WORKER_HELD_SOURCE=prior;
  await engine.disconnect();
 }
},120000);
