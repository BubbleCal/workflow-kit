#!/usr/bin/env node
import {appendFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
const args=process.argv.slice(2);
appendFileSync(join(process.cwd(),'native-queue-calls.jsonl'),JSON.stringify(args)+'\n');
if(args.length===1&&args[0]==='--version')console.log('codex-cli fixture');
else if(args.length===2&&args[0]==='queue'&&args[1]==='--help')console.log('Queue a message: --thread UUID --message TEXT');
else if(args.length===5&&args[0]==='queue'&&args[1]==='--thread'&&args[3]==='--message')console.log(`Queued message ${randomUUID()} for thread ${args[2]}.`);
else{console.error('Unexpected native CLI arguments');process.exitCode=1;}
