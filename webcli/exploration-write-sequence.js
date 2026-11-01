import { createHash } from 'node:crypto';
import { writeReview, verifyWrite, readbackWrite, writeProofDigest, finishWriteValidation } from './exploration-write.js';
import { explorationError as fail } from './exploration-commands.js';

const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const token=/^\{\{result:([a-z][a-z0-9-]{0,63})(?::([0-9]))?\}\}$/;
function mapValues(value,replace) {
  if(typeof value==='string')return replace(value);
  if(Array.isArray(value))return value.map(item=>mapValues(item,replace));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,mapValues(item,replace)]));
  return value;
}

/** A finite sequence of individually authored/generated write cases. No implicit loops. */
export function reviewWriteSequence(service,run,args) {
  const steps=args.steps;
  if(!Array.isArray(steps)||steps.length<2||steps.length>20||new Set(steps.map(step=>step?.id)).size!==steps.length)throw fail('INVALID_WRITE_SEQUENCE','Declare 2–20 unique ordered steps.');
  const seen=new Map(),cases=new Set();
  const reviewed=steps.map(step=>{
    if(!step||typeof step!=='object'||Array.isArray(step)||Object.keys(step).some(key=>!['id','tool','caseId'].includes(key))||!/^[a-z][a-z0-9-]{0,63}$/.test(step.id))throw fail('INVALID_WRITE_SEQUENCE','Each step declares only a portable id, tool and caseId.');
    const review=writeReview(service,run,step.tool,step.caseId,true);
    const key=step.tool+':'+review.caseId;if(cases.has(key))throw fail('INVALID_WRITE_SEQUENCE','Batch items require distinct authored cases; never repeat a case implicitly.');cases.add(key);
    mapValues(review.fixture,value=>{
      if(!value.includes('{{result:'))return value;
      const match=token.exec(value),prior=match&&seen.get(match[1]);
      if(!prior)throw fail('INVALID_WRITE_SEQUENCE','Result bindings must occupy a complete scalar and refer to an earlier step.');
      const specs=prior.fixture.effect.resultReadback,ids=Array.isArray(specs)?specs:specs?[specs]:[];
      const index=match[2]===undefined?0:Number(match[2]);
      if(!ids[index]||ids.length>1&&match[2]===undefined)throw fail('INVALID_WRITE_SEQUENCE','Declare the exact earlier public result ID index.');
      return value;
    });
    seen.set(step.id,review);return {id:step.id,...review};
  });
  const digest=writeProofDigest(run),planHash=hash({digest,steps:reviewed.map(step=>({id:step.id,tool:step.tool,caseId:step.caseId,fixture:step.fixture}))});
  let prior;
  if(args.resumeFrom!==undefined) {
    prior=run.writeSequenceExecutions?.find(value=>value.reviewId===args.resumeFrom);
    if(!prior||prior.planHash!==planHash||!['partial','interrupted'].includes(prior.status))throw fail('WRITE_SEQUENCE_RESUME_DENIED','Resume requires the unchanged prior partial sequence.');
    for(const step of prior.steps){const execution=run.writeExecutions?.find(value=>value.reviewId===step.reviewId);if(execution&&execution.status!=='verified'&&execution.dispatched)throw fail('WRITE_SEQUENCE_UNCERTAIN','A step may have written. Inspect effects independently; automatic continuation cannot certify it.');}
  }
  const reviewId=hash({taskId:run.taskId,planHash,resumeFrom:args.resumeFrom||null});
  return {reviewId,planHash,digest,steps:reviewed,...(prior?{resumeFrom:prior.reviewId}:{}),requiresConfirmation:true,
    policy:'Execute finite reviewed steps in order, binding only durable public IDs from earlier verified steps. Persist every dispatch, stop on any failure, never replay completed or uncertain steps. Recovery GETs do not certify uncertainty. A fresh resume review may retry only steps proven not dispatched.',
    consumed:Boolean(run.writeSequenceExecutions?.some(value=>value.reviewId===reviewId))};
}

export function verifyWriteSequence(service,run,args) {
  const existing=run.writeSequenceExecutions?.find(value=>value.reviewId===args.reviewId);
  if(existing)return service.summary(run);
  const review=reviewWriteSequence(service,run,args);
  if(args.reviewId!==review.reviewId)throw fail('STALE_REVIEW','Review the exact current sequence before dispatch.');
  if(args.confirmed!==true&&args.confirmed!=='true')throw fail('CONFIRMATION_REQUIRED','Confirm the reviewed sequence and all its effects.');
  if((run.writeSequenceExecutions?.length||0)>=20||(run.writeExecutions?.length||0)+review.steps.length>100)throw fail('WRITE_LIMIT','The task write ledger is full.');
  const previous=review.resumeFrom?run.writeSequenceExecutions.find(value=>value.reviewId===review.resumeFrom):null;
  const record={reviewId:review.reviewId,planHash:review.planHash,digest:review.digest,status:'running',steps:[],...(review.resumeFrom?{resumeFrom:review.resumeFrom}:{})};
  run.writeSequenceExecutions=[...(run.writeSequenceExecutions||[]),record];
  return service.launch(run,'verifying_write',async signal=>{
    const completed=new Map();
    try {
      for(const step of review.steps) {
        if(signal.aborted)throw fail('WRITE_SEQUENCE_CANCELLED','Sequence cancelled; no later step was dispatched.');
        if(writeProofDigest(run)!==review.digest)throw fail('STALE_DRAFT','Sequence changed before the next step.');
        const prior=previous?.steps.find(value=>value.id===step.id),priorExecution=prior&&run.writeExecutions?.find(value=>value.reviewId===prior.reviewId);
        if(priorExecution?.status==='verified') {record.steps.push({id:step.id,reviewId:prior.reviewId,status:'verified',reused:true});completed.set(step.id,priorExecution);service.save(run);continue;}
        const fixture=mapValues(step.fixture,value=>{
          const match=token.exec(value);if(!match)return value;
          const execution=completed.get(match[1]),binding=execution?.resultBinding;
          if(!binding)throw fail('WRITE_RESULT_ID_UNAVAILABLE','Earlier durable public result ID is unavailable.');
          const ids=binding.ids||[binding.id],id=ids[Number(match[2]||0)];
          if(id===undefined)throw fail('WRITE_RESULT_ID_UNAVAILABLE','Earlier durable result ID index is unavailable.');
          return id;
        });
        const stepReview={...step,fixture,reviewId:hash({sequence:review.reviewId,step:step.id})};
        const state={id:step.id,reviewId:stepReview.reviewId,status:'preparing'};record.steps.push(state);service.save(run);
        await verifyWrite(service,run,{tool:step.tool,caseId:step.caseId,reviewId:stepReview.reviewId,confirmed:true},{review:stepReview,signal,deferFinish:true});
        const execution=run.writeExecutions.find(value=>value.reviewId===stepReview.reviewId);
        state.status=execution?.status||'not_dispatched';service.save(run);
        if(state.status!=='verified')throw fail('WRITE_SEQUENCE_STEP_FAILED','Sequence stopped at the first unverified step.');
        completed.set(step.id,execution);
      }
      record.status='verified';service.save(run);
      if(!signal.aborted)finishWriteValidation(service,run);
    } catch(error) {
      record.status=signal.aborted?'interrupted':'partial';record.error={code:error.code||'WRITE_SEQUENCE_FAILED'};service.save(run);
      if(!signal.aborted)service.update(run,'write_review_ready','Sequence stopped. Inspect step effects; only proven undispatched steps can receive a new resume review.');
    }
  });
}

export async function readbackWriteSequence(service,run,reviewId) {
  const execution=run.writeSequenceExecutions?.find(value=>value.reviewId===reviewId);
  if(!execution)throw fail('STALE_REVIEW','No consumed sequence review exists.');
  const steps=[];
  for(const step of execution.steps) {
    const write=run.writeExecutions?.find(value=>value.reviewId===step.reviewId);
    if(write?.dispatched){try{steps.push({id:step.id,...await readbackWrite(service,run,step.reviewId)});}catch(error){steps.push({id:step.id,passed:false,error:{code:error.code||'WRITE_READBACK_FAILED'}});}}
    else steps.push({id:step.id,notDispatched:true});
  }
  return {reviewId,status:execution.status,steps,writeReplayed:false};
}
