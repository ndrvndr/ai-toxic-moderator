const {test}=require('node:test');
const assert=require('node:assert/strict');
const c=require('@moderator/contracts');
const message={external_message_id:'f1',author_external_id:'v1',author_display_name:'Demo',raw_text:'😀 slot RAM',published_at:'2026-09-13T10:00:00.000Z'};
test('preserves raw text and rejects injected actors/unknown fields',()=>{
 assert.equal(c.messageInput.parse(message).raw_text,message.raw_text);
 assert.equal(c.messageInput.safeParse({...message,reviewer_id:'forged'}).success,false);
});
test('limits Unicode code points, rejects whitespace and invalid timestamps',()=>{
 assert.equal(c.messageInput.safeParse({...message,raw_text:'😀'.repeat(2000)}).success,true);
 for(const changes of [{raw_text:'😀'.repeat(2001)},{raw_text:' \t\n'},{published_at:'yesterday'}])assert.equal(c.messageInput.safeParse({...message,...changes}).success,false);
});
test('feedback requires corrections and never accepts client reviewer',()=>{
 for(const label of ['FALSE_POSITIVE','FALSE_NEGATIVE','WRONG_CATEGORY'])assert.equal(c.feedbackInput.safeParse({label}).success,false);
 assert.equal(c.feedbackInput.safeParse({label:'FALSE_POSITIVE',corrected_outcome:'ALLOW'}).success,true);
 assert.equal(c.feedbackInput.safeParse({label:'CORRECT',reviewer_id:'x'}).success,false);
});
test('evidence rejects reversed spans and invented raw mappings',()=>{
 assert.equal(c.span.safeParse({start:3,end:1}).success,false);
 assert.equal(c.evidence.safeParse({representation_type:'NORMALIZED',matched_text:'slot',normalized_span:{start:0,end:4},raw_span:null,mapping_quality:'EXACT'}).success,false);
});
test('queue rejects schema drift and arbitrary payloads',()=>{
 const id='10000000-0000-4000-8000-000000000001';
 const event={event_id:id,event_type:'chat.accepted',schema_version:1,channel_id:id,session_id:id,trace_id:id,occurred_at:message.published_at,payload:{message_id:id,task_id:id,evaluation_run_id:id}};
 assert.equal(c.chatAccepted.safeParse(event).success,true);
 assert.equal(c.chatAccepted.safeParse({...event,schema_version:2}).success,false);
 assert.equal(c.chatAccepted.safeParse({...event,payload:{...event.payload,raw_text:'injected'}}).success,false);
});
test('decision cannot claim a real provider action',()=>{
 const id='10000000-0000-4000-8000-000000000001';
 assert.equal(c.simulatedAction.safeParse({id,action_type:'DELETE',status:'SUCCEEDED'}).success,false);
});
