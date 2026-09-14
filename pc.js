const p=require('@babel/parser'),fs=require('fs');let bad=0,n=0;
for(const f of process.argv.slice(2)){n++;
  try{p.parse(fs.readFileSync(f,'utf8'),{sourceType:'module',plugins:['jsx']});}
  catch(e){bad++;console.log('FAIL '+f+' :: '+e.message);}}
console.log(bad?bad+'/'+n+' FAILED':'all '+n+' parse OK');
