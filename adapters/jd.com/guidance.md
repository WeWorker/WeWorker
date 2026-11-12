# jd.com

## 多轮结果与后续动作

search-products 的 products 与 view-cart 的 items 都按实际 SKU 打开商品。open-product 返回 sku 和 productUrl；后续 buy-now 绑定 sku，当前页面不匹配或等待期间切换商品时拒绝点击。buy-now 只打开结算页，不等于下单或支付。view-orders 没有订单详情、取消或按订单付款入口，不把订单号用作 SKU。pay-now 依赖当前结算页，尚无可绑定的订单身份，不由商品查询自动推导支付动作。
