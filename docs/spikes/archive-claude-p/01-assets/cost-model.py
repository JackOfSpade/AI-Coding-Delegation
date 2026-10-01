P = {
 'v4-pro': {'hit':(0.022,0.044),'miss':(0.66,1.32),'out':(1.98,3.96)},   # (off-peak, peak) per 1M
 'flash':  {'hit':(0.003,0.006),'miss':(0.15,0.30),'out':(0.60,1.20)},
}
def session(C0=17000, Cfinal=80000, N=40, O=1000):
    delta=(Cfinal-C0)/(N-1)
    T=delta-O            # new tool-result tokens per turn (rest of delta is the assistant's own output, already cached at output end)
    ctx=[C0+i*delta for i in range(N)]
    tot_in=sum(ctx)
    ideal_miss=C0+(N-1)*T
    return dict(N=N,delta=delta,T=T,tot_in=tot_in,ideal_miss=ideal_miss,tot_out=N*O,final=ctx[-1])
def cost(model,s,hit_rate=None,peak=True,out_mult=1.0):
    p=P[model]; k=1 if peak else 0
    if hit_rate is None: miss=s['ideal_miss']
    else: miss=s['tot_in']*(1-hit_rate)
    hit=s['tot_in']-miss
    c_in=(miss*p['miss'][k]+hit*p['hit'][k])/1e6
    c_out=s['tot_out']*out_mult*p['out'][k]/1e6
    return c_in,c_out,c_in+c_out,miss,hit
for label,kw in [('default CC prefix 17k -> 80k',dict(C0=17000)),('lean prefix 5k -> 80k',dict(C0=5000))]:
    s=session(**kw)
    print('==',label,{k:round(v) for k,v in s.items()})
    for model in ['v4-pro','flash']:
        for peak in (True,False):
            row=[]
            for name,hr in [('no cache',0.0),('66% hit',0.66),('90% hit',0.90),('ideal',None)]:
                ci,co,ct,miss,hit=cost(model,s,hr,peak)
                row.append(f'{name}: ${ct:.2f} (in ${ci:.2f}+out ${co:.2f})')
            print(f"{model:7s} {'peak' if peak else 'off '} | "+' | '.join(row))
    # max effort sensitivity: 2.5k output/turn, pro
    s2=dict(s); s2['tot_out']=s['N']*2500
    for peak in (True,False):
        ci,co,ct,_,_=cost('v4-pro',s2,0.90,peak)
        print(f"v4-pro {'peak' if peak else 'off '} 90% hit, 2.5k out/turn: ${ct:.2f} (in ${ci:.2f} + out ${co:.2f})")
    print('total input tokens %.2fM; ideal miss %.0fk; output %dk' % (s['tot_in']/1e6, s['ideal_miss']/1e3, s['tot_out']/1e3))

# constant-80k upper bound (every request carries 80k)
print('== constant 80k x 40 requests (upper bound)')
s=dict(N=40,tot_in=40*80000,ideal_miss=80000+39*1000,tot_out=40000)
for peak in (True,False):
    row=[]
    for name,hr in [('no cache',0.0),('66% hit',0.66),('90% hit',0.90)]:
        ci,co,ct,_,_=cost('v4-pro',s,hr,peak); row.append(f'{name}: ${ct:.2f}')
    print('v4-pro','peak' if peak else 'off ',' | '.join(row))
