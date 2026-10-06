/* eslint-disable @typescript-eslint/no-require-imports -- Optional offline PGlite verification; no remote database is used. */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const arg = name => process.argv.find(value => value.startsWith(name+'='))?.slice(name.length+1);
const root = arg('--repo') || path.resolve(__dirname, '..');
const dataRoot = arg('--data-root') || root;
const { PGlite } = require(arg('--pglite-module') || '@electric-sql/pglite');
const read = file => fs.readFileSync(path.join(root,file),'utf8');
const migration = fs.readFileSync(path.join(dataRoot,'supabase/migrations/0019_positive_review_templates.sql'),'utf8');
const seed = fs.readFileSync(path.join(dataRoot,'supabase/seed.sql'),'utf8');
const originalSeed = execFileSync('git',['show','a55ce8b:supabase/seed.sql'],{cwd:root,encoding:'utf8'});
const templates = JSON.parse(migration.split('$templates$')[1]);
const bases = ['herb_peeling','esthetic_facial','massage_bodywork','hair_salon','nail_salon','eyelash'];
let checks=0;
const passed = message => { checks++; console.log('PASS '+message); };
async function snapshot(db, tables) {
  const result={};
  for(const table of tables) result[table]=(await db.query(`select row_to_json(t) as row from public.${table} t order by id`)).rows;
  return result;
}
const liveTables=['profiles','salons','surveys','questions','question_options'];
const templateTables=['survey_templates','template_questions','template_question_options'];
async function createDb(withV2) {
  const db=new PGlite();
  await db.exec('create schema auth; create table auth.users (id uuid primary key);');
  await db.exec(read('supabase/migrations/0001_initial_schema.sql').replace('create extension if not exists pgcrypto;',''));
  await db.exec(read('supabase/migrations/0004_create_survey_from_template.sql'));
  await db.exec(read('supabase/migrations/0005_restart_survey_from_template.sql'));
  await db.exec(originalSeed);
  if(withV2) await db.exec(read('supabase/migrations/0018_review_writing_templates.sql'));
  return db;
}
async function scenario(withV2) {
  const db=await createDb(withV2);
  try {
    const prefix=withV2?'0018適用済み':'0018未適用';
    const oldIds=(await db.query("select id from survey_templates where category in ('hair_salon','hair_salon_writing_v2') order by category")).rows.map(row=>row.id);
    const user=(await db.query('insert into auth.users values (gen_random_uuid()) returning id')).rows[0].id;
    const owner=(await db.query('insert into profiles (user_id) values ($1) returning id',[user])).rows[0].id;
    const salonIds=[];
    for(const [i,name] of ['A','B','C'].entries()) {
      const salon=(await db.query('insert into salons (owner_id,name,slug) values ($1,$2,$3) returning id',[owner,name,'test-'+i])).rows[0].id;
      salonIds.push(salon);
      if(i<oldIds.length) await db.query('select create_survey_from_template($1,$2)',[salon,oldIds[i]]);
    }
    await db.exec("update question_options set option_text='店舗独自に手直しした選択肢' where id=(select id from question_options limit 1)");
    const custom=(await db.query("insert into survey_templates (name,category) values ('独自テンプレート','owner_custom') returning id")).rows[0].id;
    const customQuestion=(await db.query("insert into template_questions (template_id,question_text,question_type) values ($1,'独自の質問','single') returning id",[custom])).rows[0].id;
    await db.query("insert into template_question_options (template_question_id,option_text) values ($1,'独自の選択肢')",[customQuestion]);
    const before=await snapshot(db,liveTables);
    const functionBefore=(await db.query("select oid,proname,prosecdef,proacl from pg_proc where proname in ('create_survey_from_template','restart_survey_from_template') order by proname")).rows;
    await db.exec(migration);
    assert.deepEqual(await snapshot(db,liveTables),before);
    assert.deepEqual((await db.query("select oid,proname,prosecdef,proacl from pg_proc where proname in ('create_survey_from_template','restart_survey_from_template') order by proname")).rows,functionBefore);
    passed(prefix+': 既存店舗・独自編集済み質問・関数の権限を保持');
    const rows=(await db.query('select category from survey_templates order by category')).rows.map(row=>row.category);
    assert.deepEqual(rows,[...bases.map(base=>base+'_writing_v3'),'owner_custom'].sort());
    assert.equal((await db.query('select option_text from template_question_options where template_question_id=$1',[customQuestion])).rows[0].option_text,'独自の選択肢');
    passed(prefix+': 旧標準だけ削除し、独自テンプレートと現行6件を保持');
    const after=await snapshot(db,[...liveTables,...templateTables]);
    await db.exec(migration);
    await db.exec(seed);
    assert.deepEqual(await snapshot(db,[...liveTables,...templateTables]),after);
    passed(prefix+': 再実行とseedでID・内容を維持し、旧版も復活しない');
    for(const oldId of oldIds) {
      await assert.rejects(db.query('select restart_survey_from_template($1,$2)',[salonIds[0],oldId]),error=>error.code==='P0002');
      await assert.rejects(db.query('select create_survey_from_template($1,$2)',[salonIds[2],oldId]),error=>error.code==='P0002');
    }
    assert.deepEqual(await snapshot(db,liveTables),before);
    passed(prefix+': 旧IDによる作成・作り直しを拒否し、店舗の質問を空にしない');
    const current=(await db.query("select id from survey_templates where category='hair_salon_writing_v3'")).rows[0].id;
    const survey=(await db.query('select restart_survey_from_template($1,$2) as id',[salonIds[0],current])).rows[0].id;
    const questions=(await db.query('select question_text,required,question_type from questions where survey_id=$1 order by sort_order',[survey])).rows;
    assert.equal(questions.length,7);
    assert.deepEqual(questions.map(q=>q.required),[true,true,false,false,false,false,false]);
    assert.equal(questions[6].question_type,'text');
    const options=(await db.query('select option_text from question_options where question_id in (select id from questions where survey_id=$1)',[survey])).rows;
    assert.ok(options.every(row=>!/気になる点|変化は感じなかった|ふつう|希望と違う|改善して|合わなかった|まだ分からない|利用する予定はない/.test(row.option_text)));
    passed(prefix+': 現行7問をコピーでき、感想は任意・好意的な選択肢だけ');
    const scratch=(await db.query('select create_survey_from_template($1,null) as id',[salonIds[2]])).rows[0].id;
    assert.equal((await db.query('select count(*)::int as n from questions where survey_id=$1',[scratch])).rows[0].n,0);
    passed(prefix+': 明示的な「0から作成」は引き続き利用可能');
  } finally { await db.close(); }
}
async function rollbackScenario() {
  const db=await createDb(true);
  try {
    await db.exec("insert into survey_templates (name,category) values ('不完全な新版','hair_salon_writing_v3')");
    const before=await snapshot(db,templateTables);
    const functions=(await db.query("select pg_get_functiondef(oid) as definition from pg_proc where proname in ('create_survey_from_template','restart_survey_from_template') order by proname")).rows;
    await assert.rejects(db.exec(migration),/旧版の削除を中止/);
    await db.exec('rollback');
    assert.deepEqual(await snapshot(db,templateTables),before);
    assert.deepEqual((await db.query("select pg_get_functiondef(oid) as definition from pg_proc where proname in ('create_survey_from_template','restart_survey_from_template') order by proname")).rows,functions);
    passed('途中失敗では、旧版削除・新版追加・関数更新のすべてをロールバック');
  } finally { await db.close(); }
}
(async()=>{
  assert.equal(templates.length,6);
  for(const template of templates) {
    assert.equal(template.questions.length,7);
    assert.deepEqual(template.questions.map(q=>q.required),[true,true,false,false,false,false,false]);
    for(const question of template.questions) {
      assert.ok(question.text.length<=200);
      assert.ok(question.options.every(option=>option.length<=100));
      assert.equal(new Set(question.options).size,question.options.length);
    }
  }
  assert.equal(seed.split('do $templates_refresh$')[1].split('commit;')[0],migration.split('do $templates_refresh$')[1].split('commit;')[0]);
  passed('6業種の質問・選択肢が画面の制約内で、seedとmigrationの内容が一致');
  await scenario(false);
  await scenario(true);
  await rollbackScenario();
  console.log(`${checks}/${checks} offline database checks passed. No external services contacted.`);
})().catch(error=>{console.error(error);process.exitCode=1;});
