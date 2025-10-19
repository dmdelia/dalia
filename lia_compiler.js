/*
LIA - A minimal text-based Scratch language compiler + exporter
Filename: lia-compiler.js

What this file provides:
- A tiny lexer + parser for the syntax you provided (subset)
- An AST -> Scratch `project.json` generator (minimal, produces a Stage with one Sprite)
- An .lia exporter (serialized AST JSON)
- An .sb3 exporter (zips project.json + empty assets) using JSZip

Limitations & notes:
- This is a minimal, extendable prototype. Many blocks and edge cases are simplified.
- To keep a single-file prototype we avoid heavy parser generators and implement a small recursive-descent parser.
- For production you'd split into modules, add richer parsing, error reporting and integrate with scratch-vm.

Dependencies (install with npm):
  npm install jszip uuid

Usage examples:
  node lia-compiler.js compile program.lia output.sb3
  node lia-compiler.js export-lia program.lia out.lia
  node lia-compiler.js ast program.lia

The input "program.lia" is plain text in your custom syntax, e.g.:

on start;
repeat(5) {
  move(10);
  turn right(15);
}

*/

const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');
const { v4: uuidv4 } = require('uuid');

// ---------------------------
// Lexer
// ---------------------------
function tokenize(input) {
  const tokens = [];
  const re = /\s*(=>|>=|<=|==|!=|\{|\}|\(|\)|;|,|\.|\+|\-|\*|\/|>=|<=|>|<|=)\s*|\s*([A-Za-z_][A-Za-z0-9_\.\"]*)\s*|\s*(\"[^\"]*\")\s*|\s*([0-9]+(?:\.[0-9]+)?)\s*/y;
  let pos = 0;
  while (pos < input.length) {
    re.lastIndex = pos;
    const m = re.exec(input);
    if (!m) {
      // skip single chars like keywords '>' etc manually
      const ch = input[pos];
      if (ch === '\n' || ch === '\r' || ch === '\t' || ch === ' ') { pos++; continue; }
      // try to match identifiers that contain punctuation (like backdrop("backdrop1")) - we'll handle in parser
      // if unknown char, throw
      throw new Error('Unexpected token at ' + pos + ': ' + input.slice(pos, pos + 20));
    }
    pos = re.lastIndex;
    if (m[1]) tokens.push({type:'punct', value: m[1]});
    else if (m[2]) tokens.push({type:'ident', value: m[2]});
    else if (m[3]) tokens.push({type:'string', value: m[3].slice(1, -1)});
    else if (m[4]) tokens.push({type:'number', value: Number(m[4])});
  }
  tokens.push({type:'eof'});
  return tokens;
}

// ---------------------------
// Parser (very small subset)
// Produces AST nodes
// ---------------------------

function Parser(tokens) {
  this.tokens = tokens;
  this.pos = 0;
}
Parser.prototype.peek = function() { return this.tokens[this.pos]; };
Parser.prototype.next = function() { return this.tokens[this.pos++]; };
Parser.prototype.expect = function(type, val) {
  const t = this.peek();
  if (t.type !== type || (val !== undefined && t.value !== val)) throw new Error('Expected '+type+(val? ':'+val:'')+' got '+JSON.stringify(t));
  return this.next();
};

Parser.prototype.parseProgram = function() {
  const body = [];
  while (this.peek().type !== 'eof') {
    body.push(this.parseStatement());
  }
  return {type:'Program', body};
};

Parser.prototype.parseStatement = function() {
  const t = this.peek();
  if (t.type === 'ident') {
    // detect keywords like on, move, repeat, if, say, costume, etc.
    const val = t.value;
    if (val === 'on') return this.parseEvent();
    if (val === 'repeat') return this.parseRepeat();
    if (val === 'loop') { this.next(); this.expect('punct', '{'); const body = this.parseBlock(); return {type:'LoopStatement', body}; }
    if (val === 'if') return this.parseIf();
    if (val === 'await') return this.parseAwait();
    if (val === 'say' || val === 'think' || val === 'show' || val === 'hide' || val === 'move' || val === 'turn' || val === 'costume' || val === 'backdrop' || val === 'ease' || val === 'point' || val === 'change' || val === 'set' || val === 'sound' || val === 'wait' || val === 'clone' || val === 'delete' || val === 'send') return this.parseSimple();
    // fallback try simple
    return this.parseSimple();
  }
  if (t.type === 'punct' && t.value === ';') { this.next(); return {type:'Empty'}; }
  throw new Error('Unexpected token in statement: ' + JSON.stringify(t));
};

Parser.prototype.parseBlock = function() {
  const stmts = [];
  while (!(this.peek().type === 'punct' && this.peek().value === '}')) {
    if (this.peek().type === 'eof') throw new Error('Unclosed block');
    stmts.push(this.parseStatement());
  }
  this.expect('punct', '}');
  return stmts;
};

Parser.prototype.parseEvent = function() {
  this.expect('ident', 'on');
  const t = this.next();
  if (t.type === 'ident' && t.value === 'start') { this.expect('punct',';'); return {type:'Event', kind:'start'}; }
  if (t.type === 'ident' && t.value === 'key') {
    this.expect('punct','(');
    const key = this.next(); if (key.type !== 'ident' && key.type !== 'string') throw new Error('Expected key');
    this.expect('punct',')');
    this.expect('punct',';');
    return {type:'Event', kind:'key', key: key.value};
  }
  if (t.type === 'ident' && t.value === 'click') { this.expect('punct',';'); return {type:'Event', kind:'click'}; }
  if (t.type === 'ident' && t.value === 'backdrop') {
    this.expect('punct','(');
    const name = this.next(); if (name.type !== 'string' && name.type !== 'ident') throw new Error('Expected string');
    this.expect('punct',')');
    this.expect('punct',';');
    return {type:'Event', kind:'backdrop', name: name.value};
  }
  // fallback
  throw new Error('Unknown event ' + JSON.stringify(t));
};

Parser.prototype.parseRepeat = function() {
  this.expect('ident','repeat');
  this.expect('punct','(');
  const num = this.next(); if (num.type !== 'number') throw new Error('Expected number in repeat');
  this.expect('punct',')');
  this.expect('punct','{');
  const body = this.parseBlock();
  return {type:'Repeat', count: num.value, body};
};

Parser.prototype.parseIf = function() {
  this.expect('ident','if');
  this.expect('punct','(');
  // crude condition parse: read until ')'
  let condTokens = [];
  while (!(this.peek().type === 'punct' && this.peek().value === ')')) condTokens.push(this.next());
  this.expect('punct',')');
  this.expect('punct','{');
  const consequent = this.parseBlock();
  let alternate = null;
  if (this.peek().type === 'ident' && this.peek().value === 'else') {
    this.next();
    this.expect('punct','{');
    alternate = this.parseBlock();
  }
  return {type:'If', condition: condTokens.map(t=>t.value).join(' '), consequent, alternate};
};

Parser.prototype.parseAwait = function() {
  this.expect('ident','await');
  if (this.peek().type === 'ident' && this.peek().value === 'until') {
    this.next();
    this.expect('punct','(');
    let condTokens = [];
    while (!(this.peek().type === 'punct' && this.peek().value === ')')) condTokens.push(this.next());
    this.expect('punct',')');
    this.expect('punct',';');
    return {type:'AwaitUntil', condition: condTokens.map(t=>t.value).join(' ')};
  }
  throw new Error('Unknown await form');
};

Parser.prototype.parseSimple = function() {
  // parse starting ident and possible parens; consume ending semicolon
  const nameToken = this.next();
  const name = nameToken.value;
  let node = {type:'Call', name, args: []};
  if (this.peek().type === 'punct' && this.peek().value === '(') {
    this.next();
    // parse comma-separated args until ')'
    while (!(this.peek().type === 'punct' && this.peek().value === ')')) {
      const t = this.next();
      if (t.type === 'number' || t.type === 'string' || t.type === 'ident') node.args.push(t.value);
      else throw new Error('Unexpected arg token '+JSON.stringify(t));
      if (this.peek().type === 'punct' && this.peek().value === ',') this.next();
    }
    this.expect('punct',')');
  }
  // handle `for(2)` after say("hi") for(2);
  if (this.peek().type === 'ident' && this.peek().value === 'for') {
    this.next(); this.expect('punct','(');
    const n = this.next(); if (n.type !== 'number') throw new Error('Expected number in for'); this.expect('punct',')');
    node.for = n.value;
  }
  // expect semicolon
  if (this.peek().type === 'punct' && this.peek().value === ';') this.next();
  else throw new Error('Expected semicolon after statement ' + name);
  return node;
};

// ---------------------------
// AST -> Scratch JSON generator (minimal)
// We will create a single sprite ("Sprite1") and put blocks in sequence
// Note: This generator produces simple linear scripts from the AST
// ---------------------------

function generateProject(ast) {
  const blocks = {};
  let lastBlockId = null;

  function addBlock(opcode, inputs = {}, fields = {}, next = null, parent = null) {
    const id = uuidv4().replace(/-/g, '').slice(0, 20);
    blocks[id] = {
      opcode,
      inputs,
      fields,
      next,
      parent
    };
    return id;
  }

  function compileStatement(stmt) {
    if (stmt.type === 'Call') {
      // map some names to opcodes
      if (stmt.name === 'move') {
        const steps = stmt.args[0] || 10;
        return addBlock('motion_movesteps', {STEPS: [1, [4, steps]]});
      }
      if (stmt.name === 'turn') {
        // turn right(15) or turn lef(15)
        const dir = stmt.args[0];
        const amount = stmt.args[1] || 15;
        if (dir === 'right') return addBlock('motion_turnright', {DEGREES: [1, [4, amount]]});
        if (dir === 'lef' || dir === 'left') return addBlock('motion_turnleft', {DEGREES: [1, [4, amount]]});
      }
      if (stmt.name === 'say') {
        const txt = stmt.args[0] || '';
        if (stmt.for) return addBlock('looks_sayforsecs', {MESSAGE: [10, txt], SECS: [1, [4, stmt.for]]});
        return addBlock('looks_say', {MESSAGE: [10, txt]});
      }
      if (stmt.name === 'wait') {
        const t = stmt.args[0] || 1;
        return addBlock('control_wait', {DURATION: [1, [4, t]]});
      }
      if (stmt.name === 'repeat') {
        // handled elsewhere
      }
      // unhandled: return a noop
      return addBlock('procedures_call', {});
    }
    if (stmt.type === 'Repeat') {
      // Create a repeat block and compile body into a substack
      const repId = uuidv4().replace(/-/g, '').slice(0, 20);
      const bodyFirst = compileStatements(stmt.body);
      // create repeat block with SUBSTACK pointing to first block id
      const repBlockId = addBlock('control_repeat', {TIMES: [1, [4, stmt.count]], SUBSTACK: [2, bodyFirst.first]}, {}, null);
      // make sure the body blocks' parent are set to repBlockId
      if (bodyFirst.blocksOrder.length) {
        blocks[bodyFirst.first].parent = repBlockId;
      }
      return repBlockId;
    }
    if (stmt.type === 'Event') {
      // produce corresponding hat block
      if (stmt.kind === 'start') return addBlock('event_whenflagclicked', {}, {});
      if (stmt.kind === 'click') return addBlock('event_whenthisspriteclicked', {}, {});
      if (stmt.kind === 'backdrop') return addBlock('event_whenbackdropswitchesto', {BACKDROP: [10, stmt.name]}, {});
    }
    if (stmt.type === 'LoopStatement') {
      const bodyFirst = compileStatements(stmt.body);
      const loopId = addBlock('control_forever', {SUBSTACK: [2, bodyFirst.first]});
      if (bodyFirst.blocksOrder.length) blocks[bodyFirst.first].parent = loopId;
      return loopId;
    }
    if (stmt.type === 'If') {
      const bodyFirst = compileStatements(stmt.consequent);
      const ifId = addBlock('control_if', {CONDITION: [1, stmt.condition], SUBSTACK: [2, bodyFirst.first]});
      if (bodyFirst.blocksOrder.length) blocks[bodyFirst.first].parent = ifId;
      return ifId;
    }
    if (stmt.type === 'AwaitUntil') {
      // map to repeat until
      const bodyId = addBlock('control_wait_until', {CONDITION: [1, stmt.condition]});
      return bodyId;
    }
    if (stmt.type === 'Empty') return null;
    throw new Error('Unhandled stmt type ' + stmt.type);
  }

  function compileStatements(stmts) {
    const order = [];
    let firstId = null;
    let prevId = null;
    for (const s of stmts) {
      const id = compileStatement(s);
      if (!id) continue;
      order.push(id);
      if (prevId) blocks[prevId].next = id;
      prevId = id;
      if (!firstId) firstId = id;
    }
    return {first: firstId, last: prevId, blocksOrder: order};
  }

  // Top-level: compile program body as a script attached to the Stage or a sprite.
  // We'll create scripts for each top-level Event.
  const scripts = [];
  for (const node of ast.body) {
    if (node.type === 'Event') {
      // compile the following statements until next event as a sequence
      // For simplicity we associate single-event blocks only.
      const hatId = compileStatement(node);
      // find following statements in ast.body after this node - naive: events with no explicit block body will attach next immediate statements if they are Calls; but our parser produces Event statements only. Simpler: for now create single hat per event
      // TODO: attach actual body if you implement 'on start { ... }'
      scripts.push(hatId);
    } else {
      // top-level non-event statements -> create a start hat and attach
      // create a start hat at beginning if not created
      const startHat = addBlock('event_whenflagclicked', {}, {});
      const compiled = compileStatements(ast.body);
      // connect hat -> first
      if (compiled.first) blocks[startHat].next = compiled.first;
      break; // done
    }
  }

  // Build minimal project.json
  const project = {
    targets: [
      {
        isStage: true,
        name: 'Stage',
        variables: {},
        lists: {},
        broadcasts: {},
        blocks,
        currentCostume: 0,
        costumes: [
          {name: 'backdrop1', md5ext: 'backdrop1.svg', dataFormat: 'svg', rotationCenterX: 240, rotationCenterY: 180}
        ],
        sounds: [],
        volume: 100,
        layerOrder: 0,
        tempo: 60,
        videoTransparency: 50
      }
    ],
    meta: {semver: '3.0.0', vm: '0.2.0', agent: 'LIA-compiler'}
  };
  return project;
}

// ---------------------------
// Exporters
// ---------------------------

async function exportSB3(projectJSON, outPath) {
  const zip = new JSZip();
  zip.file('project.json', JSON.stringify(projectJSON, null, 2));
  // include a minimal empty costume file as placeholder
  zip.file('backdrop1.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360"></svg>');
  const content = await zip.generateAsync({type:'nodebuffer'});
  fs.writeFileSync(outPath, content);
}

function exportLia(ast, outPath) {
  fs.writeFileSync(outPath, JSON.stringify(ast, null, 2));
}

// ---------------------------
// CLI
// ---------------------------

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length < 2) {
    console.log('Usage: node lia-compiler.js <command> <file> [out]');
    console.log('commands: compile, ast, export-lia');
    process.exit(1);
  }
  const cmd = argv[0];
  const file = argv[1];
  const out = argv[2] || (cmd === 'compile' ? 'out.sb3' : 'out.lia');
  const src = fs.readFileSync(file, 'utf8');
  const tokens = tokenize(src);
  const p = new Parser(tokens);
  const ast = p.parseProgram();
  if (cmd === 'ast') {
    console.log(JSON.stringify(ast, null, 2));
    return;
  }
  if (cmd === 'export-lia') {
    exportLia(ast, out);
    console.log('Exported .lia to', out);
    return;
  }
  if (cmd === 'compile') {
    const project = generateProject(ast);
    await exportSB3(project, out);
    console.log('Compiled to', out);
    return;
  }
  console.log('Unknown command');
}

if (require.main === module) main().catch(e=>{ console.error(e); process.exit(1); });
