# juejin.cn generated adapter integration

This generated adapter was sanitized before being added to the public repository.

Included tools:

- `juejin.cn.check_login_status`
- `juejin.cn.like_current_item`
- `juejin.cn.favorite_current_item`
- `juejin.cn.list_detail_candidates`

Removed from the archived generated assets:

- Side-effecting like/favorite draft tools.
- Captured request URLs with tracking parameters.
- Captured session, user, item, author, and event identifiers.
- Local developer machine paths.

The current like/favorite tools are runtime DOM actions. They rely on the
currently open browser page and the current signed-in session, and they must only
be invoked after explicit user confirmation.

`juejin.cn.like_current_item` ensures the current article is liked; if the
article is already liked, it returns without clicking again to avoid toggling the
state off.

`juejin.cn.favorite_current_item` ensures the current article is collected. If
Juejin opens the collection picker, the tool selects `collection_name` when
provided; otherwise it selects the first visible collection, then clicks
`确定`.
