// Original Lunacrust score, synthesized from an authored algorithm. MIT.
// No samples, imported melodies, external synthesis software, or network needed.
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const dir = fileURLToPath(new URL('../app/audio/', import.meta.url));
mkdirSync(dir, {recursive:true});
const rate = 22050;
const scores = [
  {key:'classic',sec:158,root:45,notes:[0,7,14,19,23,14,7,12],pulse:2.7},
  {key:'dark-cave',sec:235,root:33,notes:[0,7,10,17,14,7,3,10],pulse:4.9},
  {key:'explore',sec:168,root:50,notes:[0,9,16,21,14,7,19,9],pulse:2.1},
];
const hz=n=>440*Math.pow(2,(n-69)/12);
for (const score of scores) {
  const count=score.sec*rate, data=Buffer.alloc(44+count*2);
  data.write('RIFF');data.writeUInt32LE(36+count*2,4);data.write('WAVEfmt ',8);
  data.writeUInt32LE(16,16);data.writeUInt16LE(1,20);data.writeUInt16LE(1,22);
  data.writeUInt32LE(rate,24);data.writeUInt32LE(rate*2,28);data.writeUInt16LE(2,32);data.writeUInt16LE(16,34);
  data.write('data',36);data.writeUInt32LE(count*2,40);
  const base=hz(score.root), TAU=Math.PI*2;
  for(let i=0;i<count;i++) {
    const t=i/rate, phrase=Math.floor(t/(score.pulse*8)), index=Math.floor(t/score.pulse);
    const nt=t%score.pulse, note=score.notes[(index+phrase*3)%score.notes.length];
    const freq=hz(score.root+12+note), env=(1-Math.exp(-nt*7))*Math.exp(-nt*1.2);
    const pad=(Math.sin(TAU*base*t)+.45*Math.sin(TAU*base*1.5*t)+.3*Math.sin(TAU*base*2.003*t))*.07;
    const bell=(Math.sin(TAU*freq*t)+.19*Math.sin(TAU*freq*2.01*t))*.12*env;
    const shimmer=.015*Math.sin(TAU*base*4*t)*Math.sin(t*.17)*Math.sin(t*.23);
    const fade=Math.min(1,t/4,(score.sec-t)/6);
    const value=(pad*(.7+.3*Math.sin(t*.19))+bell+shimmer)*Math.max(0,fade);
    data.writeInt16LE(Math.round(Math.max(-.8,Math.min(.8,value))*32767),44+i*2);
  }
  writeFileSync(`${dir}${score.key}.wav`,data);
  console.log(`Synthesized ${score.key}.wav (${score.sec}s, original score)`);
}
