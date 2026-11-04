import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const execute=promisify(execFile);
export function sourceInterval(config,count) {
  // One complete read currently needs at least nine REST requests; reserve
  // twelve for pagination and leave most of the shared quota for real work.
  const budget=config.github_read_budget_per_hour??1800;
  return Math.max(config.poll_min_ms,Math.ceil(Math.max(1,count)*12*3600000/budget));
}
export async function readGitHubQuota() {
  const result=await execute('gh',['api','--include','rate_limit'],{timeout:15000,maxBuffer:1024*1024});
  const boundary=result.stdout.search(/\r?\n\r?\n/);
  if(boundary<0)throw new Error('Missing GitHub quota response headers');
  const headers=result.stdout.slice(0,boundary),data=JSON.parse(result.stdout.slice(boundary).trim());
  const core={...data.resources?.core},graphql=data.resources?.graphql;
  const remaining=headers.match(/^x-ratelimit-remaining:\s*(\d+)/im),reset=headers.match(/^x-ratelimit-reset:\s*(\d+)/im);
  if(remaining)core.remaining=Number(remaining[1]);if(reset)core.reset=Number(reset[1]);
  if(!Number.isFinite(core.remaining)||!Number.isFinite(core.reset))throw new Error('Incomplete GitHub quota evidence');
  return {core,graphql};
}
export class SourceRate {
  constructor(db,{now=()=>Date.now(),readQuota=readGitHubQuota}={}) {
    this.db=db;this.now=now;this.readQuota=readQuota;
    db.exec('CREATE TABLE IF NOT EXISTS rt_source_rate (source TEXT PRIMARY KEY,paused_until INTEGER NOT NULL,failures INTEGER NOT NULL,data TEXT NOT NULL)');
  }
  current(){return this.db.prepare("SELECT * FROM rt_source_rate WHERE source='github'").get();}
  paused(){return (this.current()?.paused_until??0)>this.now();}
  async observe(error) {
    if(!/rate limit exceeded|secondary rate limit|HTTP 429/i.test(error.message))return null;
    if(this.paused())return this.current().paused_until;
    if(this.pending)return this.pending;
    this.pending=(async()=>{
      const failures=(this.current()?.failures??0)+1;let quota=null;
      try{quota=await this.readQuota();}catch{}
      const exhausted=[quota?.core,quota?.graphql].filter(q=>q?.remaining===0&&Number.isFinite(q.reset));
      const reset=exhausted.length?Math.max(...exhausted.map(q=>q.reset*1000+1000)):null;
      const until=Math.max(this.now()+60000,reset??this.now()+Math.min(900000,60000*2**Math.min(4,failures-1)));
      this.db.prepare("INSERT INTO rt_source_rate VALUES ('github',?,?,?) ON CONFLICT(source) DO UPDATE SET paused_until=excluded.paused_until,failures=excluded.failures,data=excluded.data")
        .run(until,failures,JSON.stringify({observed_at:this.now(),quota,reason:'provider_rate_limit',engineering_paused:false}));
      return until;
    })();
    try{return await this.pending;}finally{this.pending=null;}
  }
  success(){if(!this.paused())this.db.prepare("UPDATE rt_source_rate SET paused_until=0,failures=0 WHERE source='github'").run();}
}
