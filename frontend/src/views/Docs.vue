<script setup lang="ts">
import { onMounted } from 'vue'
import { setHead } from '../head'

onMounted(() => {
  // Delivery/ops notes, not customer content: keep it out of the index even if
  // someone links to it. The server-side sitemap no longer lists /doc/.
  setHead('客户文档 - WoolBuddy', 'WoolBuddy 当前交付入口、功能范围、运维文档和测试验证清单。', {
    canonical: `${window.location.origin}/doc/`,
    robots: 'noindex,nofollow'
  })
})
</script>

<template>
  <main class="section docs-page">
    <section class="page-hero compact-hero">
      <p class="eyebrow">交付文档</p>
      <h1>WoolBuddy 客户文档</h1>
      <p class="lead">当前线上版本包含官网、管理端、订单、上传、PayPal 真实支付跳转、账户订单、博客、政策页、AI 问答和自动化回归。</p>
    </section>

    <section class="panel docs-panel">
      <h2>线上入口</h2>
      <div class="doc-link-grid">
        <RouterLink class="doc-link-card" to="/"><strong>前台官网</strong><span>首页、分类、商品、下单和政策内容</span></RouterLink>
        <RouterLink class="doc-link-card" to="/admin"><strong>管理端</strong><span>订单、用户、商品、分类和站点配置</span></RouterLink>
        <RouterLink class="doc-link-card" to="/order"><strong>定制下单</strong><span>上传照片、选择规格、创建订单和支付单</span></RouterLink>
        <RouterLink class="doc-link-card" to="/account"><strong>我的订单</strong><span>客户登录、查看订单、继续支付和追踪物流</span></RouterLink>
      </div>
    </section>

    <section class="panel docs-panel">
      <h2>交付范围</h2>
      <div class="mini-list">
        <p><span><strong>官网</strong><small>首页、分类筛选、商品详情、博客、客服政策、移动端布局和 SEO head。</small></span></p>
        <p><span><strong>交易流程</strong><small>照片上传、订单提交、PayPal 创建/跳转/确认、订单账户恢复和尾款支付。</small></span></p>
        <p><span><strong>管理端</strong><small>用户管理、分类/商品弹窗编辑、订单状态、异常标记、导出、备份、站点与支付配置。</small></span></p>
        <p><span><strong>运维</strong><small>数据备份、恢复 dry-run、测试数据清理、孤儿上传检查和 smoke-check。</small></span></p>
      </div>
    </section>

    <section class="panel docs-panel">
      <h2>验证方式</h2>
      <pre>npm run build
bash scripts/smoke-check.sh
node test-results/e2e-check.mjs</pre>
      <p class="muted">完整 E2E 覆盖官网、管理端、支付、备份恢复、安全头、移动端布局、空态和异常流程。</p>
    </section>
  </main>
</template>
