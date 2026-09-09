import { parse } from '@babel/parser';
import { readFileSync } from 'fs';
import traverseMod from '@babel/traverse';
const traverse = traverseMod.default || traverseMod;

const file = process.argv[2];
const ast = parse(readFileSync(file,'utf8'), { sourceType:'module', plugins:['jsx'] });

// Find the LAST top-level return in the component (the real render).
let target = null;
traverse(ast, {
  ReturnStatement(p) {
    if (p.node.argument && (p.node.argument.type==='JSXElement'||p.node.argument.type==='JSXFragment')) {
      const size = p.node.end - p.node.start;
      if (!target || size > target._size) { target = p.node.argument; target._size = size; }
    }
  }
});

const KEEP = new Set(['flex','flexGrow','style','contentContainerStyle','behavior',
  'keyboardVerticalOffset','className','edges','paddingBottom']);

function name(n){
  if(n.type==='JSXFragment') return '<>';
  const o=n.openingElement.name;
  return o.name || (o.object? `${o.object.name}.${o.property.name}`:'?');
}
function props(n){
  if(n.type==='JSXFragment') return '';
  return n.openingElement.attributes.filter(a=>a.type==='JSXAttribute'&&KEEP.has(a.name.name))
    .map(a=>{
      let v='';
      if(a.value?.type==='StringLiteral') v=a.value.value;
      else if(a.value?.type==='JSXExpressionContainer') v='{'+
        (a.value.expression.type==='ObjectExpression'
          ? a.value.expression.properties.map(p=>p.key?.name??'?').join(',')
          : '…')+'}';
      return `${a.name.name}="${v}"`;
    }).join(' ');
}
function walk(n, d=0, out=[]){
  if(!n || (n.type!=='JSXElement'&&n.type!=='JSXFragment')) return out;
  const nm=name(n);
  // only structural containers
  if(/^(View|ScrollView|SafeAreaView|KeyboardAvoidingView|Modal|FlatList|>)/.test(nm)||nm==='<>'){
    out.push('  '.repeat(d)+nm+(props(n)?'  '+props(n):''));
    d++;
  }
  for(const c of (n.children||[])) {
    if(c.type==='JSXElement'||c.type==='JSXFragment') walk(c,d,out);
    else if(c.type==='JSXExpressionContainer'){
      const e=c.expression;
      const kids=[e?.consequent,e?.alternate,e?.right,e?.body].filter(Boolean);
      for(const k of kids) walk(k,d,out);
    }
  }
  return out;
}
console.log(walk(target).slice(0,26).join('\n'));
