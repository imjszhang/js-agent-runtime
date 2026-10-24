import test from 'node:test';
import assert from 'node:assert/strict';
import { createParser } from '../dist/parsers.js';

const parse = events => {
  const parser=createParser('claude-code'), emitted=[];
  for(const event of events)emitted.push(...parser.push(event));
  return {...parser.finish(),events:emitted};
};
const assistant = content => ({type:'assistant',message:{id:'response-1',model:'real-model',content,usage:{input_tokens:400,output_tokens:0}}});
const result = usage => ({type:'result',subtype:'success',result:'answer',usage});

test('Claude partial messages deliver text before the final response while totals count the run once',()=>{
  const r=parse([
    {type:'stream_event',session_id:'session-1',event:{type:'message_start',message:{id:'response-1',model:'real-model',usage:{input_tokens:400,output_tokens:0}}}},
    {type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'an'}}},
    {type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'swer'}}},
    {type:'stream_event',event:{type:'message_delta',usage:{output_tokens:4}}},
    assistant([{type:'text',text:'answer'}]),
    result({input_tokens:10,output_tokens:4,cache_read_input_tokens:3,cache_creation_input_tokens:2}),
  ]);
  assert.equal(r.completed,true);assert.equal(r.text,'answer');assert.equal(r.responseModel,'real-model');assert.equal(r.sessionId,'session-1');
  assert.deepEqual(r.events.filter(e=>e.type==='message').map(e=>e.data.text),['an','answer','answer']);
  assert.deepEqual(r.usage,{inputTokens:15,outputTokens:4,totalTokens:19,cachedInputTokens:3,reasoningTokens:null});
});

test('Claude zero placeholders and partial response accounting never become a complete run total',()=>{
  for(const content of [[{type:'text',text:'output'}],[{type:'thinking',thinking:'thought'}],[{type:'tool_use',name:'Read',input:{file_path:'a'}}]]){
    assert.equal(parse([assistant(content),{...result({input_tokens:10,output_tokens:0}),result:''}]).usage,null);
  }
  assert.equal(parse([result({input_tokens:10,output_tokens:0})]).usage,null);
  assert.equal(parse([assistant([{type:'text',text:'answer'}]),result(undefined)]).usage,null);
  assert.equal(parse([assistant([{type:'text',text:'answer'}])]).usage,null);
  assert.equal(parse([result({input_tokens:10.5,output_tokens:2})]).usage,null);
  const empty=parse([{...result({input_tokens:0,output_tokens:0}),result:''}]);
  assert.equal(empty.usage.totalTokens,0);
});

test('Claude partial tool output is visible and zero-token use stays unknown',()=>{
  const r=parse([
    {type:'stream_event',event:{type:'content_block_start',index:0,content_block:{type:'tool_use',id:'tool-1',name:'Read',input:{}}}},
    {type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:'{"file_path":"a"}'}}},
    {...result({input_tokens:10,output_tokens:0}),result:''},
  ]);
  assert.equal(r.events.filter(e=>e.type==='tool').length,1);assert.equal(r.usage,null);
});

test('Claude error results preserve native diagnostic details',()=>{
  const r=parse([{type:'result',subtype:'error_during_execution',errors:['first detail','second detail']}]);
  assert.equal(r.failed,true);assert.equal(r.error,'first detail; second detail');
});


test('Claude rejects root output and duplicate results after the terminal without overwriting the final answer',()=>{
  const terminal={...result({input_tokens:10,output_tokens:4}),result:'final answer',total_cost_usd:0.25,modelUsage:{'final-model':{}}};
  const tails=[
    {type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:'unfinished next answer'}}},
    {type:'stream_event',event:{type:'message_start',message:{model:'wrong-model'}}},
    assistant([{type:'text',text:'late assistant'}]),
    {...result({input_tokens:100,output_tokens:200}),result:'replacement',total_cost_usd:9,modelUsage:{'wrong-model':{}}},
  ];
  for(const tail of tails){
    const r=parse([terminal,tail]);
    assert.equal(r.completed,false);assert.equal(r.failed,true);assert.match(r.error,/after its terminal result/);
    assert.equal(r.text,'final answer');assert.equal(r.responseModel,'final-model');assert.deepEqual(r.cost,{total:0.25,currency:'USD'});
    assert.equal(r.usage.totalTokens,14);assert.equal(r.events.filter(e=>e.type==='raw').length,2);
  }
  const unknown=parse([terminal,{type:'future_diagnostic',detail:'allowed metadata'}]);
  assert.equal(unknown.completed,true);assert.equal(unknown.failed,false);assert.equal(unknown.text,'final answer');
});

test('Claude nested results never complete or overwrite the root response and accounting',()=>{
  const child={...result({input_tokens:100,output_tokens:200}),parent_tool_use_id:'subagent-call',session_id:'child-session',result:'child answer',total_cost_usd:9,modelUsage:{'child-model':{}}};
  const childOnly=parse([child]);
  assert.equal(childOnly.completed,false);assert.equal(childOnly.text,'');assert.equal(childOnly.sessionId,null);assert.equal(childOnly.responseModel,null);
  assert.equal(childOnly.usage,null);assert.equal(childOnly.cost,null);assert.equal(childOnly.events.length,1);
  const terminal={...result({input_tokens:10,output_tokens:4}),session_id:'root-session',result:'root answer',total_cost_usd:0.25,modelUsage:{'root-model':{}}};
  const r=parse([child,terminal,child]);
  assert.equal(r.completed,true);assert.equal(r.failed,false);assert.equal(r.text,'root answer');assert.equal(r.sessionId,'root-session');assert.equal(r.responseModel,'root-model');
  assert.equal(r.usage.totalTokens,14);assert.deepEqual(r.cost,{total:0.25,currency:'USD'});assert.equal(r.events.filter(e=>e.type==='usage').length,1);
});

test('Claude nested assistant and streaming text stay out of root output while tools remain observable',()=>{
  const child=e=>({...e,parent_tool_use_id:'subagent-call',session_id:'child-session',model:'child-model'});
  const r=parse([
    {type:'stream_event',session_id:'root-session',event:{type:'message_start',message:{model:'root-model'}}},
    {type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:'root '}}},
    child({type:'stream_event',event:{type:'message_start',message:{model:'child-model'}}}),
    child({type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:'child text'}}}),
    child(assistant([{type:'text',text:'child answer'},{type:'tool_use',name:'Read',id:'child-tool'}])),
    child({type:'stream_event',event:{type:'content_block_start',content_block:{type:'tool_use',name:'Read',id:'streamed-child-tool'}}}),
    {type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:'answer'}}},
  ]);
  assert.equal(r.completed,false);assert.equal(r.text,'root answer');assert.equal(r.responseModel,'root-model');assert.equal(r.sessionId,'root-session');
  assert.deepEqual(r.events.filter(e=>e.type==='message').map(e=>e.data.text),['root ','root answer']);
  assert.equal(r.events.filter(e=>e.type==='tool').length,2);assert.equal(r.events.filter(e=>e.type==='raw').length,7);assert.equal(r.usage,null);
});
