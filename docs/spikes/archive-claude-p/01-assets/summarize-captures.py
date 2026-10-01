import json,sys,glob,os
for d in sys.argv[1:]:
    print('###',d, open(f'out/{d}/exit.txt').read().strip(), '| stderr:', open(f'out/{d}/stderr.txt').read().strip()[:200].replace('\n',' / '))
    try:
        so=json.load(open(f'out/{d}/stdout.json')); print('   result:',repr(so.get('result'))[:80],'is_error',so.get('is_error'),'cost',so.get('total_cost_usd'))
    except Exception as e: print('   stdout parse',e)
    for l in open(f'out/{d}/requests.jsonl'):
        r=json.loads(l); b=r['body'] or {}
        print('  ',r['method'],r['url'],'| model=',b.get('model'),'| metadata=',json.dumps(b.get('metadata')),'| thinking=',json.dumps(b.get('thinking')),'| output_config=',json.dumps(b.get('output_config')),'| ctxmgmt=',json.dumps(b.get('context_management')) , '| max_tokens=',b.get('max_tokens'),'| tools=',len(b.get('tools',[])))
        sysb=b.get('system')
        if isinstance(sysb,list): print('     system[0]:', sysb[0].get('text','')[:90])
        print('     beta:', r['headers'].get('anthropic-beta'))
