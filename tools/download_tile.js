const fs=require('fs');
async function get(url,path,attempts=5){
 for(let i=1;i<=attempts;i++){
  try{
   console.log('attempt',i);
   const res=await fetch(url,{signal:AbortSignal.timeout(180000)});
   if(!res.ok) throw new Error('HTTP '+res.status);
   const total=Number(res.headers.get('content-length')||0);
   const ws=fs.createWriteStream(path+'.part'); let n=0;
   for await(const chunk of res.body){ws.write(chunk); n+=chunk.length; if(n% (5*1024*1024)<chunk.length) console.log((n/1048576).toFixed(1)+'MB');}
   await new Promise(r=>ws.end(r));
   if(total && n!==total) throw new Error('short '+n+'/'+total);
   fs.renameSync(path+'.part',path); console.log('done',n); return;
  }catch(e){console.log('ERR',e.message); await new Promise(r=>setTimeout(r,2000));}
 }
 process.exit(1);
}
get('https://s3.amazonaws.com/elevation-tiles-prod/skadi/N29/N29E102.hgt.gz','data/N29E102.hgt.gz');
