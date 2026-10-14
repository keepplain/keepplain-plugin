// The window: a welcome wizard, then Home, Sessions (with the confirmation before each send) and Settings, over the
// keepplain CLI. Everything it shows comes from a command's JSON (window.ct.call, preload.cjs); everything it changes
// is one command. Text from sessions is the person's own, so all of it is escaped.

const call = (method, params = {}, onEvent = null) => window.ct.call(method, params, onEvent);

// The site's agent glyphs (resources/js/lib/format.ts, agentGlyph).
const AGENTS = {
    'claude-code': { name: 'Claude Code', mark: 'cc' },
    codex: { name: 'Codex', mark: 'cx' },
    cursor: { name: 'Cursor', mark: 'cu' },
    pi: { name: 'Pi', mark: 'pi' },
};
const SEND_MODES = [
    { mode: 'off', title: 'Ask me each time', text: 'Nothing leaves until you pick a session and press Send.', tag: 'Recommended' },
    { mode: 'on', title: 'Send automatically', text: 'Sessions go to your private drafts as you work, with secrets hidden first. Nothing is published.' },
    { mode: 'team', title: 'Only team projects', text: 'Only sessions in repositories of teams that ask for it go, to the team. Everything else stays here.' },
];
const REFRESH_ON_FOCUS_MS = 30_000;

const ICONS = {
    home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="3.5" cy="6" r="1"/><circle cx="3.5" cy="12" r="1"/><circle cx="3.5" cy="18" r="1"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    alert: '<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
    shieldCheck: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/>',
    send: '<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4z"/>',
    refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4L21 8"/><path d="M21 3v5h-5"/>',
    download: '<path d="M12 3v12M7 10l5 5 5-5"/><path d="M5 21h14"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
    users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/>',
    out: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6M10 14 21 3"/>',
    back: '<path d="M19 12H5M12 19l-7-7 7-7"/>',
    inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5h13L22 12v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6z"/>',
};
/**
 * The logo, as the site's BrandMark.vue draws it (its paths are the site's resources/js/lib/brand.ts): the cursor in
 * the text colour over its peach-to-orange trail, so it follows the theme. With the wordmark "KeepPlain" beside it.
 */
const MARK_CURSOR = 'M306 429A53.5 53.5 0 0 1 394.2 388.2L768.5 705.6A28 28 0 0 1 750.4 755L519.4 755A16 16 0 0 0 507 760.9L346.8 956.1A23 23 0 0 1 306 941.5Z';
const MARK_TRAIL = 'M506 346A35 35 0 0 1 551.9 312.8L930.1 438A48 48 0 0 1 963 483.6L963 702.6A30 30 0 0 1 922.4 730.6L506 573Z';
const WORDMARK = 'M1594.2 205.0L1597.0 204.9L1598.6 206.0L1599.3 208.0L1599.5 462.0L1600.7 467.0L1602.6 471.0L1604.0 472.7L1609.0 476.2L1619.0 478.3L1620.0 479.0L1620.4 485.0L1620.0 486.0L1619.0 486.6L1616.0 486.7L1528.0 486.6L1526.8 485.0L1526.8 480.0L1527.2 479.0L1537.9 476.0L1543.0 472.8L1546.2 468.0L1548.3 459.0L1548.6 246.0L1548.3 241.0L1546.1 237.0L1541.0 233.8L1529.0 229.7L1527.8 228.0L1527.8 223.0L1529.0 221.8L1532.0 220.8ZM1834.1 223.0L1839.0 222.3L1844.0 222.4L1847.0 222.9L1853.0 225.0L1858.0 227.9L1861.4 231.0L1866.2 238.0L1867.5 241.0L1868.6 246.0L1868.8 252.0L1868.3 256.0L1866.3 262.0L1864.1 266.0L1860.7 270.0L1855.0 274.5L1851.0 276.5L1843.0 278.1L1837.0 278.1L1832.0 277.0L1825.0 274.2L1821.0 271.3L1817.9 268.0L1814.7 263.0L1812.8 258.0L1811.9 252.0L1812.0 247.6L1812.7 243.0L1815.6 236.0L1819.0 231.5L1823.0 227.8L1828.0 224.9ZM526.6 230.0L630.0 229.8L631.0 229.8L632.3 231.0L632.3 237.0L631.5 238.0L622.0 239.8L618.0 240.9L613.4 243.0L609.0 247.1L606.8 251.0L605.8 254.0L604.8 259.0L604.5 267.0L604.4 355.0L604.5 361.0L605.0 362.3L625.3 343.0L689.0 278.3L698.1 268.0L703.5 261.0L706.4 255.0L707.0 252.0L707.1 250.0L706.1 246.0L703.5 243.0L700.0 241.0L688.0 238.0L687.3 236.0L687.3 232.0L688.0 230.4L703.0 229.9L779.2 230.0L779.8 231.0L779.9 237.0L779.0 238.4L768.0 241.0L755.3 246.0L743.0 253.0L730.0 262.8L705.0 285.9L659.2 330.0L656.3 333.0L656.0 334.0L727.6 429.0L753.6 462.0L760.0 468.1L768.0 473.1L776.0 476.1L788.0 478.4L788.8 480.0L788.5 486.0L787.0 486.7L754.0 486.8L708.0 486.7L707.0 486.2L695.4 470.0L640.3 396.0L620.0 369.2L619.0 368.6L604.4 383.0L604.7 458.0L606.8 466.0L609.9 471.0L612.1 473.0L616.0 475.1L624.0 477.2L631.0 478.1L632.0 478.8L632.2 486.0L631.0 486.8L623.0 486.9L526.0 486.4L525.4 485.0L525.4 480.0L526.0 478.6L535.0 477.1L541.0 475.2L546.0 472.2L549.4 468.0L551.4 464.0L552.5 459.0L553.1 440.0L553.1 289.0L552.3 257.0L550.3 250.0L548.3 247.0L545.0 243.9L539.0 240.9L535.0 239.7L527.0 238.4L526.0 237.8L525.4 236.0L525.4 231.0ZM1317.8 230.0L1451.0 229.6L1458.0 229.9L1471.0 231.9L1482.0 234.9L1490.0 238.0L1499.0 242.8L1505.0 246.9L1511.7 253.0L1516.3 258.0L1519.3 262.0L1523.3 269.0L1527.2 280.0L1529.6 293.0L1529.9 304.0L1528.3 318.0L1525.3 329.0L1520.5 339.0L1514.5 348.0L1505.9 357.0L1497.0 364.2L1485.0 371.4L1473.0 376.4L1463.0 379.4L1450.0 382.2L1437.0 383.7L1426.0 384.4L1399.0 384.4L1398.3 385.0L1398.2 450.0L1398.6 457.0L1399.6 462.0L1403.0 468.5L1406.5 472.0L1410.0 474.1L1416.0 476.1L1432.0 478.2L1433.0 478.8L1433.3 485.0L1433.0 486.0L1432.0 486.6L1331.0 486.9L1319.0 486.6L1318.0 486.5L1317.0 485.2L1316.9 480.0L1318.0 478.5L1330.0 476.2L1335.0 474.4L1340.0 470.8L1343.5 466.0L1345.2 461.0L1346.1 455.0L1346.4 430.0L1346.1 260.0L1344.4 252.0L1342.5 248.0L1340.2 245.0L1337.0 242.7L1332.8 241.0L1318.0 237.8L1316.9 236.0L1317.1 231.0ZM1399.0 241.2L1398.1 243.0L1398.2 371.0L1399.0 372.1L1421.0 371.6L1435.0 369.3L1445.0 365.3L1450.0 362.3L1455.5 358.0L1462.4 350.0L1469.4 337.0L1473.3 323.0L1474.7 310.0L1474.5 293.0L1471.3 278.0L1467.3 268.0L1461.3 259.0L1455.0 252.8L1446.0 246.8L1438.0 243.8L1428.0 241.8ZM2014.4 302.0L2026.0 302.4L2033.0 303.5L2040.0 305.6L2047.0 308.8L2053.0 312.7L2059.0 318.2L2063.5 324.0L2067.3 331.0L2070.3 341.0L2071.6 352.0L2071.9 462.0L2073.8 469.0L2075.7 472.0L2078.0 474.1L2082.0 476.2L2092.0 478.3L2092.9 479.0L2093.0 485.0L2092.0 486.5L2001.0 486.7L1999.3 486.0L1999.1 480.0L1999.6 479.0L2010.0 476.3L2015.0 473.2L2018.1 469.0L2020.2 462.0L2020.7 454.0L2020.7 364.0L2020.3 358.0L2018.4 350.0L2016.3 345.0L2013.4 341.0L2010.0 337.7L2004.0 334.6L1993.0 332.5L1989.0 332.6L1983.0 333.6L1974.0 336.8L1969.0 339.7L1963.2 344.0L1955.6 351.0L1955.2 352.0L1955.6 463.0L1957.6 470.0L1961.0 474.3L1967.0 477.1L1974.0 478.5L1974.7 479.0L1975.3 480.0L1975.3 485.0L1975.0 486.0L1974.0 486.7L1794.0 486.8L1792.6 486.0L1792.0 480.1L1791.0 480.2L1780.0 486.3L1772.0 489.3L1761.0 491.3L1751.0 491.2L1746.0 490.2L1741.0 488.2L1735.2 484.0L1730.7 479.0L1727.9 474.0L1726.0 468.7L1725.0 467.6L1717.0 475.0L1710.0 480.4L1702.0 485.1L1695.0 488.1L1688.0 490.0L1681.0 491.2L1667.0 491.4L1655.0 489.2L1649.2 487.0L1644.0 484.3L1638.1 480.0L1632.8 475.0L1629.9 471.0L1626.6 465.0L1624.9 460.0L1623.5 453.0L1623.5 442.0L1624.6 435.0L1626.7 429.0L1628.8 425.0L1633.9 418.0L1638.0 413.8L1643.0 409.8L1651.0 404.7L1665.0 397.8L1682.0 391.9L1723.0 379.5L1724.0 378.0L1724.1 362.0L1723.6 352.0L1722.2 342.0L1720.2 335.0L1717.3 329.0L1713.0 323.8L1707.0 319.9L1701.0 317.6L1692.0 317.1L1685.0 317.8L1677.0 321.5L1674.5 324.0L1673.7 328.0L1675.7 341.0L1675.4 349.0L1672.5 357.0L1669.5 361.0L1666.0 364.1L1662.0 366.3L1658.0 367.6L1654.0 368.4L1648.0 368.4L1641.0 366.1L1635.0 361.8L1632.6 359.0L1631.0 356.0L1629.7 353.0L1628.7 348.0L1628.8 343.0L1629.5 340.0L1632.6 333.0L1636.8 327.0L1644.0 320.6L1652.0 315.5L1660.0 311.6L1675.0 306.5L1689.0 303.6L1703.0 302.2L1721.0 302.4L1736.0 304.7L1747.0 308.4L1756.0 313.5L1764.2 321.0L1768.2 327.0L1771.3 334.0L1773.2 341.0L1774.1 349.0L1774.3 456.0L1774.7 462.0L1775.7 465.0L1777.0 466.8L1779.5 469.0L1782.0 470.0L1787.0 469.8L1794.0 467.0L1796.0 467.5L1798.8 473.0L1798.4 474.0L1795.3 477.0L1796.0 477.9L1803.0 476.2L1808.0 473.3L1811.3 469.0L1813.1 462.0L1813.5 456.0L1813.5 342.0L1812.3 338.0L1810.0 335.7L1806.0 333.5L1794.0 328.8L1793.5 328.0L1793.5 322.0L1794.0 321.4L1803.0 318.6L1859.0 302.8L1861.0 302.5L1863.0 303.6L1863.6 305.0L1863.8 317.0L1863.8 460.0L1865.6 468.0L1869.0 473.2L1872.0 475.3L1876.4 477.0L1882.0 478.1L1885.0 478.2L1892.0 477.0L1896.0 475.4L1899.3 473.0L1902.1 469.0L1903.6 465.0L1904.3 461.0L1904.7 438.0L1904.7 341.0L1903.5 338.0L1901.0 335.6L1895.0 332.5L1886.0 328.9L1885.3 328.0L1885.4 322.0L1902.0 316.5L1951.0 302.5L1953.0 302.7L1955.3 305.0L1955.4 333.0L1956.0 334.9L1971.0 320.7L1984.0 311.5L1991.0 307.8L2000.0 304.5L2008.0 302.7ZM862.6 305.0L870.0 304.6L879.0 304.9L886.0 305.7L898.0 308.6L912.0 314.7L926.0 324.6L935.3 335.0L939.2 341.0L942.2 347.0L946.3 359.0L948.4 372.0L948.6 379.0L948.6 384.0L948.0 385.1L947.0 385.4L835.0 385.4L829.0 385.5L827.8 386.0L827.9 398.0L829.4 410.0L832.6 423.0L835.4 430.0L840.9 440.0L846.9 447.0L855.0 453.3L863.0 457.3L872.0 460.2L881.0 461.4L893.0 461.1L904.0 459.0L914.0 455.1L924.0 448.6L931.0 441.8L941.0 428.3L943.0 428.8L948.3 432.0L948.3 434.0L945.2 441.0L935.1 457.0L930.2 463.0L924.0 469.2L914.0 477.0L903.8 483.0L894.0 487.2L882.0 490.2L874.0 491.3L864.0 491.7L854.0 491.3L846.0 490.2L832.0 486.2L823.0 482.1L815.0 477.2L811.0 474.3L802.9 467.0L793.6 456.0L788.6 448.0L784.8 440.0L781.8 431.0L779.8 423.0L778.3 413.0L777.9 404.0L778.0 396.8L779.9 381.0L783.7 367.0L790.0 353.0L794.9 345.0L800.9 337.0L807.0 330.7L816.0 322.9L824.0 317.6L831.0 313.8L839.0 310.4L848.0 307.6ZM1042.9 305.0L1059.0 304.9L1066.0 305.6L1075.0 307.7L1081.0 309.6L1088.0 312.7L1095.0 316.7L1102.0 321.7L1107.0 326.2L1112.3 332.0L1117.3 339.0L1120.1 344.0L1124.2 354.0L1126.3 361.0L1128.3 375.0L1128.3 384.0L1127.0 385.3L1017.0 385.4L1008.0 385.5L1007.0 386.0L1007.2 398.0L1009.4 414.0L1012.6 425.0L1015.7 432.0L1019.8 439.0L1027.5 448.0L1034.0 453.3L1044.0 458.0L1052.0 460.2L1064.0 461.4L1075.0 460.8L1084.0 458.9L1095.0 454.1L1103.8 448.0L1112.0 439.8L1120.0 428.6L1121.0 428.5L1126.0 430.9L1128.0 432.4L1128.2 433.0L1123.3 443.0L1115.2 456.0L1107.0 465.5L1096.0 475.1L1085.0 482.1L1076.0 486.2L1066.0 489.2L1051.0 491.5L1032.0 491.2L1017.0 488.0L1009.0 485.1L999.0 480.3L988.0 472.2L979.5 464.0L974.5 458.0L966.0 444.0L962.8 436.0L960.0 426.9L957.9 415.0L957.5 409.0L957.9 390.0L959.8 379.0L961.9 371.0L965.0 362.0L968.8 354.0L972.9 347.0L978.8 339.0L991.0 326.6L1000.0 319.7L1007.0 315.5L1018.0 310.6L1024.0 308.6L1032.0 306.6ZM1252.0 305.0L1260.0 305.0L1271.0 306.7L1280.0 309.5L1292.0 315.5L1298.0 319.6L1308.0 329.2L1315.3 339.0L1319.2 346.0L1323.3 356.0L1326.3 367.0L1328.6 383.0L1328.7 396.0L1327.2 410.0L1325.6 418.0L1322.4 429.0L1318.2 439.0L1314.3 446.0L1308.2 455.0L1303.2 461.0L1296.0 468.1L1288.0 474.3L1282.0 478.2L1276.9 481.0L1265.0 486.2L1259.0 488.2L1248.0 490.2L1232.0 491.0L1224.0 490.3L1218.0 489.2L1208.0 486.1L1200.0 482.0L1199.0 482.7L1198.8 539.0L1199.4 546.0L1200.6 551.0L1203.8 557.0L1206.0 559.4L1209.0 561.3L1215.0 563.3L1228.0 565.2L1230.0 566.0L1230.4 567.0L1230.0 573.3L1229.0 573.8L1209.0 573.9L1124.0 573.6L1123.0 573.0L1122.7 572.0L1123.2 566.0L1125.0 565.1L1130.0 564.3L1136.0 562.5L1140.0 560.3L1144.0 556.0L1146.5 551.0L1147.5 546.0L1148.2 538.0L1148.1 345.0L1147.3 342.0L1145.0 339.7L1129.0 332.8L1128.4 331.0L1128.7 326.0L1145.0 320.7L1196.0 306.0L1198.0 307.0L1198.6 308.0L1199.0 333.0L1200.0 333.9L1211.0 322.5L1217.0 317.7L1225.0 312.7L1231.0 309.8L1240.0 306.7ZM861.0 318.8L855.0 320.5L849.0 323.8L844.0 328.0L839.7 333.0L835.7 340.0L832.5 348.0L829.6 360.0L828.5 369.0L830.0 369.7L900.0 369.4L900.2 359.0L898.2 346.0L896.3 340.0L891.4 331.0L885.0 324.5L878.0 320.4L870.0 318.5ZM1040.0 319.0L1032.0 321.6L1027.0 324.6L1022.4 329.0L1017.9 335.0L1013.6 343.0L1010.6 352.0L1008.8 360.0L1007.9 369.0L1009.0 369.7L1013.0 369.7L1079.0 369.5L1079.5 369.0L1079.6 360.0L1079.3 354.0L1078.1 347.0L1075.0 338.0L1070.3 330.0L1064.0 323.7L1056.0 319.7L1048.0 318.4ZM1225.0 334.8L1218.0 336.8L1209.0 341.6L1202.8 347.0L1199.1 351.0L1198.9 352.0L1198.9 442.0L1199.7 448.0L1202.4 456.0L1205.7 462.0L1211.0 468.1L1217.0 472.1L1224.4 475.0L1229.0 475.6L1236.0 475.5L1246.0 473.1L1253.0 469.3L1261.0 461.7L1265.3 456.0L1267.5 452.0L1272.4 440.0L1276.3 424.0L1277.5 411.0L1277.4 394.0L1275.3 379.0L1273.4 371.0L1267.3 357.0L1260.6 348.0L1255.0 342.7L1249.0 338.7L1245.0 336.9L1236.0 334.5ZM1723.0 392.8L1706.0 397.9L1692.0 404.0L1685.0 408.7L1681.2 412.0L1677.6 416.0L1675.0 420.2L1672.8 425.0L1671.7 430.0L1671.2 438.0L1671.8 445.0L1674.0 452.0L1676.0 455.7L1679.0 459.2L1684.0 463.0L1689.0 465.1L1694.0 466.0L1699.0 465.9L1704.0 465.1L1709.0 463.2L1714.0 460.5L1720.0 456.1L1723.8 452.0L1723.8 394.0Z';
let brands = 0;
const brand = (size = 22, word = true) => {
    const id = `kp-trail-${++brands}`;
    const wordH = Math.round(size / 0.88);
    const mark = `<svg width="${size}" height="${size}" viewBox="296 302 678 674" aria-hidden="true"><defs><linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="520" y1="600" x2="975" y2="430"><stop offset="0" stop-color="#FDDCCB"/><stop offset=".55" stop-color="#FCA47E"/><stop offset="1" stop-color="#FC6631"/></linearGradient></defs><path fill="url(#${id})" d="${MARK_TRAIL}"/><path fill="currentColor" d="${MARK_CURSOR}"/></svg>`;
    const wordmark = word ? `<svg class="wordmark" width="${Math.round((wordH * 1572) / 373)}" height="${wordH}" viewBox="524 203 1572 373" aria-label="KeepPlain" role="img"><path fill="currentColor" d="${WORDMARK}"/></svg>` : '';

    return `<span class="brand">${mark}${wordmark}</span>`;
};
const icon = (name, cls = '') => `<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;

const state = {
    view: 'boot',
    init: null,
    status: null,
    statusError: null,
    loading: false,
    loadedAt: 0,
    account: null,
    wizard: { phase: 'idle', login: null, loginError: null, agents: [], error: null, done: null, past: { found: null, on: true, scanning: false, asked: false }, share: null, teamsError: null },
    pastBusy: false,
    agentOp: null,
    sessions: { list: null, loading: false, error: null, query: '', agent: 'all', folder: null },
    confirm: null,
    settings: { busy: null, input: '' },
    toasts: [],
    /** The app's own update (src/main/updater.mjs); asked: the person pressed "Check for updates" and expects an answer. */
    update: { state: 'off' },
    updateAsked: false,
};

/* ---------- helpers ---------- */

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const agentName = (id) => AGENTS[id]?.name ?? id;
const mark = (id, cls = '') => `<span class="mark ${esc(id)} ${cls}">${esc(AGENTS[id]?.mark ?? '?')}</span>`;
const connectedAgents = () => (state.status?.agents ?? []).filter((a) => a.connected);
const siteHost = () => (state.status?.site ? new URL(state.status.site).host : 'keepplain.com');
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const capital = (text) => text.charAt(0).toUpperCase() + text.slice(1);

function ago(iso) {
    const ms = Date.now() - Date.parse(iso);
    if (!Number.isFinite(ms)) return '';
    const min = Math.round(ms / 60_000);
    if (min < 1) return 'just now';
    if (min < 60) return `${min} min ago`;
    const h = Math.round(min / 60);
    if (h < 24) return `${plural(h, 'hour')} ago`;
    const d = Math.round(h / 24);
    if (d < 30) return `${plural(d, 'day')} ago`;

    return new Date(iso).toLocaleDateString();
}

const time = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** "Today", "Yesterday", "Monday", or the date: the headers of the sessions list. */
function dayOf(iso) {
    const at = new Date(iso);
    const start = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const days = Math.round((start(new Date()) - start(at)) / 86_400_000);
    if (days === 0) return 'Today';
    if (days === 1) return 'Yesterday';
    if (days < 7) return at.toLocaleDateString([], { weekday: 'long' });

    return at.toLocaleDateString([], { month: 'long', day: 'numeric' });
}

/** The CLI's words, said for someone who has not read its manual. */
function friendly(error) {
    const text = String(error ?? '');
    if (/not connected to .* yet/i.test(text)) return 'You are not signed in yet. Sign in from Home first.';
    if (/token was not accepted/i.test(text)) return 'Your sign-in has expired. Sign in again from Home.';
    if (/Could not reach|ENOTFOUND|ECONNREFUSED|ETIMEDOUT/i.test(text)) return `Can't reach ${siteHost()}. Check your internet connection and try again.`;
    if (/nothing to send yet/i.test(text)) return 'This session has no prompts yet, so there is nothing to send.';
    if (/Too many requests/i.test(text)) return text.replace('Too many requests.', 'KeepPlain is busy.');

    return text;
}

function alertHtml(kind, text, details = null) {
    if (!text) return '';

    return `<div class="alert ${kind}">${icon(kind === 'ok' ? 'check' : 'alert', 'sm')}<div class="grow">${esc(text)}${details ? `<details><summary>Details</summary><pre>${esc(details)}</pre></details>` : ''}</div></div>`;
}

function toast(text, kind = '') {
    const t = { text, kind, id: Math.random() };
    // One at a time: a newer one says what matters now.
    state.toasts = [t];
    render();
    setTimeout(() => {
        state.toasts = state.toasts.filter((x) => x !== t);
        render();
    }, 2600);
}

/* ---------- data ---------- */

async function loadStatus({ quiet = false } = {}) {
    if (!quiet) {
        state.loading = true;
        render();
    }
    const r = await call('status');
    state.loading = false;
    state.loadedAt = Date.now();
    if (r.ok) {
        state.status = r.result;
        state.statusError = null;
    } else state.statusError = friendly(r.error);
    render();
    watchPast();

    return r.ok;
}

/** Whether the saved sign-in still works: asked in the background. */
async function checkAccount() {
    if (!state.status?.signed_in) {
        state.account = null;
        return render();
    }
    const r = await call('whoami');
    state.account = r.ok ? { ok: true, username: r.result.username } : { ok: false, error: friendly(r.error) };
    render();
}

async function loadSessions({ quiet = false } = {}) {
    const s = state.sessions;
    if (!quiet) s.loading = true;
    s.error = null;
    render();
    const r = await call('sessions', { folder: s.folder });
    s.loading = false;
    if (r.ok) s.list = r.result.sessions;
    else s.error = friendly(r.error);
    render();
}

/* ---------- start ---------- */

/** What the update's state says in Settings. */
function updateLine(u) {
    return {
        off: 'Updates are checked by the installed app.',
        store: 'Updates come from the Microsoft Store.',
        idle: '',
        checking: 'Checking for updates…',
        none: 'You have the latest version.',
        downloading: `Downloading ${u.version ?? 'the update'}… ${u.percent ?? 0}%`,
        ready: `Version ${u.version} is ready: restart to use it.`,
        error: `Could not check for updates: ${u.error}`,
    }[u.state] ?? '';
}

window.ct.onUpdate((u) => {
    const asked = state.updateAsked;
    state.update = u;
    if (asked && ['none', 'error', 'ready'].includes(u.state)) {
        state.updateAsked = false;
        if (u.state !== 'ready') toast(u.state === 'none' ? 'You have the latest version' : updateLine(u), u.state === 'error' ? 'bad' : '');
    }
    if (u.state === 'ready' && !asked) toast(`Update ${u.version} is ready`);
    render();
});

async function checkUpdates() {
    state.updateAsked = true;
    state.update = await call('checkUpdates');
    render();
}

async function boot() {
    state.init = await call('init');
    state.update = await call('updateState');
    document.documentElement.classList.toggle('mac', state.init.platform === 'darwin');
    if (state.init.cliError) {
        state.view = 'welcome';
        return render();
    }
    state.view = 'welcome';
    await loadStatus();
    if (state.status?.signed_in && connectedAgents().length) {
        state.view = 'home';
        render();
        checkAccount();
        return;
    }
    scanPast();
}

/**
 * The past sessions the welcome offers to import, counted on this computer: nothing is sent to count them. Signed in,
 * the CLI also asks the site whether this account's import is still open (once per account): closed, nothing is offered.
 * A no said in the terminal comes back unticked.
 */
async function scanPast() {
    const before = state.status?.past_import;
    if (before && !['declined'].includes(before.status)) return;
    const past = state.wizard.past;
    past.scanning = true;
    render();
    const r = await call('pastFound');
    past.scanning = false;
    if (r.ok && r.result) {
        past.found = r.result.closed ? null : r.result;
        if (before?.status === 'declined' && !past.touched) past.on = false;
    }
    render();
}

/** "shop 80, api 41 and 3 more projects", from the projects import-past found. */
function projectsLine(projects = []) {
    const named = projects.slice(0, 3).map((p) => `${p.project} ${p.count}`);
    const rest = projects.length - named.length;

    return rest > 0 ? `${named.join(', ')} and ${rest} more project${rest === 1 ? '' : 's'}` : named.join(', ');
}

/** The welcome's tick is on and there is something to import. */
const importingPast = () => state.wizard.past.on && (state.wizard.past.found?.found ?? 0) > 0;
/** The import was set up by this very welcome (not one from before, which the done event also reports). */
const pastStarted = (w) => w.past.asked && ['running', 'login'].includes(w.done?.past_import?.status) && w.done.past_import.total > 0;

/* ---------- welcome ---------- */

async function getStarted() {
    const w = state.wizard;
    if (w.phase === 'login' || w.phase === 'connect') return;
    Object.assign(w, { phase: 'login', login: null, loginError: null, agents: [], error: null, done: null });
    render();

    const signed = await call('login', {}, (e) => {
        if (e.event === 'opened') {
            w.login = e;
            render();
        }
    });
    if (!signed.ok) {
        w.phase = 'idle';
        w.loginError = signed.cancelled ? null : friendly(signed.error);
        return render();
    }
    w.username = signed.events.find((e) => e.event === 'connected')?.username;

    const agents = (state.status?.agents ?? []).filter((a) => a.present).map((a) => a.id);
    if (!agents.length) {
        w.phase = 'idle';
        w.error = 'No coding agent was found on this computer. Install Claude Code, Codex, Cursor or Pi, then try again.';
        return render();
    }
    // Signed in now: whether this account may still import (once per account) is known.
    if (w.past.found && !state.status?.past_import) await scanPast();
    w.phase = 'connect';
    w.past.asked = importingPast();
    render();
    const r = await call('connect', { agents, importPast: w.past.asked }, (e) => onAgentEvent(e, w.agents));
    w.phase = 'done';
    if (!r.ok) w.error = friendly(r.error);
    else w.done = r.events.at(-1) ?? null;
    await loadStatus({ quiet: true });
    render();
    if (pastStarted(w)) await offerTeams();
}

/**
 * Right after the import is set up: the sessions that ran in a team's repositories, one team at a time, each ticked
 * only when auto mode already sends this computer's sessions to that team (import-past teams says so).
 */
async function offerTeams() {
    const w = state.wizard;
    // Until the teams are known, setup is not over: the question must not be skipped by opening the app.
    w.phase = 'teams';
    w.teamsError = null;
    render();
    const r = await call('pastTeams');
    const offers = r.ok ? (r.result?.teams ?? []) : [];
    if (!r.ok) w.teamsError = friendly(r.error);
    if (!offers.length) {
        w.phase = 'done';
        return render();
    }
    w.share = { offers, index: 0, chosen: new Set(offers[0].default ? offers[0].sessions.map((s) => s.id) : []), busy: false, error: null };
    w.phase = 'share';
    render();
}

async function answerTeam(share) {
    const s = state.wizard.share;
    const offer = s.offers[s.index];
    s.busy = true;
    render();
    const r = await call('pastShare', { team: offer.slug, sessions: share ? [...s.chosen] : [] });
    s.busy = false;
    if (!r.ok) {
        s.error = friendly(r.error);
        return render();
    }
    if (share && s.chosen.size) toast(`${s.chosen.size} session${s.chosen.size === 1 ? '' : 's'} will go to ${offer.name}`);
    s.index++;
    s.error = null;
    const next = s.offers[s.index];
    if (next) s.chosen = new Set(next.default ? next.sessions.map((x) => x.id) : []);
    else state.wizard.phase = 'done';
    render();
}

function shareScreen() {
    const s = state.wizard.share;
    const offer = s.offers[s.index];
    const n = offer.sessions.length;
    const all = s.chosen.size === n;

    return `<div class="card share-team">
        <h2 class="title">${n === 1 ? 'One of these sessions' : `${Number(n)} of these sessions`} ran in ${esc(offer.name)}’s repositories. Share ${n === 1 ? 'it' : 'them'} with ${esc(offer.name)} too?</h2>
        <div class="muted small">Ticked ones move to the team’s space once they are imported, and its members see them as they see the team’s other sessions. The rest stay in your private drafts.${offer.default ? ' Ticked because your agents already send this computer’s sessions to the team.' : ''}</div>
        <label class="share-row all"><input type="checkbox" id="share-all" data-action="share-all" ${all ? 'checked' : ''} ${s.busy ? 'disabled' : ''}><span><strong>All ${Number(n)}</strong></span></label>
        <ul class="share-list">${offer.sessions
            .map((x) => `<li><label class="share-row"><input type="checkbox" id="share-${esc(x.id)}" data-action="share-one" data-id="${esc(x.id)}" ${s.chosen.has(x.id) ? 'checked' : ''} ${s.busy ? 'disabled' : ''}><span class="grow"><span class="clip">${esc(x.prompt || 'Session')}</span><span class="faint small">${esc(x.project)} · ${esc(agentName(x.agent))} · ${esc(ago(x.last_active))}</span></span></label></li>`)
            .join('')}</ul>
        ${alertHtml('bad', s.error)}
        <div class="row gap">
            <button class="btn primary" data-action="share-team" ${s.busy || !s.chosen.size ? 'disabled' : ''}>${s.busy ? '<span class="spinner"></span> ' : ''}Share ${s.chosen.size ? Number(s.chosen.size) : ''} with ${esc(offer.name)}</button>
            <button class="btn" data-action="keep-private" ${s.busy ? 'disabled' : ''}>Keep them private</button>
        </div>
    </div>`;
}

/** enable's and disable's events, one line per agent. */
function onAgentEvent(e, list) {
    if (e.event !== 'step') return;
    let step = list.find((s) => s.agent === e.agent);
    if (!step) list.push((step = { agent: e.agent }));
    step.status = e.status;
    step.off = /take KeepPlain off|uninstall/.test(e.text);
    step.message = e.status === 'failed' ? e.message : null;
    step.details = e.status === 'failed' ? e.details : null;
    render();
}

function agentSteps(list) {
    if (!list.length) return '';

    return `<ul class="mini">${list
        .map((s) => {
            const name = agentName(s.agent);
            const verb = s.off ? ['Disconnecting', 'disconnected', 'disconnect'] : ['Adding KeepPlain to', 'ready', 'add KeepPlain to'];
            const text = s.status === 'running' ? `${verb[0]} ${name}…` : s.status === 'done' ? `${name} ${verb[1]}` : `Could not ${verb[2]} ${name}`;
            const ico = s.status === 'running' ? '<span class="spinner"></span>' : icon(s.status === 'done' ? 'check' : 'x', 'sm');

            return `<li class="${s.status}"><span class="ico">${ico}</span><div class="grow">${esc(text)}
                ${s.message ? `<div class="faint small">${esc(s.message)}</div>` : ''}
                ${s.details ? `<details><summary>What ${esc(name)} said</summary><pre>${esc(s.details)}</pre></details>` : ''}</div></li>`;
        })
        .join('')}</ul>`;
}

/** The closing notes of enable worth reading: restart, trust the hooks, steps by hand. */
function todo(done) {
    const restart = (done?.installed ?? []).map((a) => `${a.restart} to load the plugin.`);
    // The import of past sessions has its own line on the welcome.
    const notes = (done?.notes ?? []).filter((n) => !/is installed\. /.test(n) && !/^Not signed in/.test(n) && !/past sessions? (to your private drafts|will go)/.test(n));

    return [...restart, ...notes];
}

function viewWelcome() {
    const w = state.wizard;
    const agents = state.status?.agents ?? [];
    const found = agents.filter((a) => a.present);
    const stepClass = (n) => {
        const order = { idle: 1, login: 2, connect: 3, done: 4, teams: 4, share: 4 }[w.phase];
        if (n === 1) return state.loading ? 'running' : 'done';
        if (n === 2) return w.loginError ? 'failed' : order > 2 ? 'done' : order === 2 ? 'running' : 'pending';
        return order === 4 ? (w.error || w.done?.failed?.length ? 'failed' : 'done') : order === 3 ? 'running' : 'pending';
    };
    const num = (n) => (stepClass(n) === 'done' ? icon('check', 'sm') : stepClass(n) === 'failed' ? icon('x', 'sm') : n);
    const busy = w.phase === 'login' || w.phase === 'connect' || w.past.scanning;
    const setUp = ['done', 'teams', 'share'].includes(w.phase);
    const steps = todo(w.done);
    const past = w.past.found;
    const pastDays = past?.days ?? 30;

    if (state.init?.cliError) {
        return `<div class="welcome"><div class="welcome-card"><div class="hero">${brand(26)}<h1>KeepPlain could not start</h1></div>
            ${alertHtml('bad', state.init.cliError)}<p class="muted small">Reinstalling the app usually fixes this.</p></div></div>`;
    }

    return `<div class="welcome"><div class="welcome-card">
        <div class="hero">
            ${brand(26)}
            <h1>${setUp && !w.error ? 'You’re all set' : 'Welcome to KeepPlain'}</h1>
            <p>${setUp && !w.error ? 'KeepPlain now works inside your agents, so you can close this app: nothing needs it running. Open it again to send a session by hand or to change a setting.' : 'Share the AI coding sessions worth learning from. Nothing leaves this computer until you say yes.'}</p>
        </div>
        <div class="card">
            <ol class="steps">
                <li class="${stepClass(1)}"><span class="num">${num(1)}</span><div class="grow">
                    <div class="title">Find your coding agents</div>
                    ${
                        state.loading && !agents.length
                            ? '<div class="muted small"><span class="spinner"></span> Looking on this computer…</div>'
                            : `<div class="chips">${agents.map((a) => `<span class="chip ${a.present ? '' : 'off'}">${mark(a.id, `sm ${a.present ? '' : 'off'}`)}${esc(a.name)}${a.present ? '' : ' · not installed'}</span>`).join('')}</div>`
                    }
                    ${alertHtml('bad', state.statusError)}
                </div></li>
                <li class="${stepClass(2)}"><span class="num">${num(2)}</span><div class="grow">
                    <div class="title">${w.username ? `Signed in as @${esc(w.username)}` : 'Sign in with your browser'}</div>
                    ${!w.username && w.phase !== 'login' ? `<div class="muted small">Your browser opens ${esc(siteHost())}; you press Connect there. No password is typed here.</div>` : ''}
                    ${
                        w.phase === 'login'
                            ? w.login
                                ? `<div class="code-box"><div class="muted small">Your browser opened. Check that it shows this code, then press <strong>Connect</strong>:</div>
                                <span class="code">${esc(w.login.user_code)}</span>
                                <div class="row small"><button class="link" data-action="open" data-url="${esc(w.login.url)}">Open the page again</button><button class="link" data-action="cancel-login">Cancel</button></div></div>`
                                : '<div class="muted small"><span class="spinner"></span> Opening your browser…</div>'
                            : ''
                    }
                    ${alertHtml('bad', w.loginError)}
                </div></li>
                <li class="${stepClass(3)}"><span class="num">${num(3)}</span><div class="grow">
                    <div class="title">Add KeepPlain to your agents</div>
                    ${w.agents.length ? agentSteps(w.agents) : `<div class="muted small">${found.length ? `Adds a small plugin to ${found.map((a) => esc(a.name)).join(', ')}.` : 'No agent found yet.'}</div>`}
                    ${alertHtml('bad', w.error)}
                </div></li>
            </ol>
        </div>
        ${
            past?.found && !setUp
                ? `<label class="card past-choice"><input type="checkbox" id="past-tick" data-action="past-tick" ${w.past.on ? 'checked' : ''} ${busy ? 'disabled' : ''}><span class="grow">
                    <span class="title">Import my sessions from the last ${Number(pastDays)} days</span>
                    <span class="muted small">${Number(past.found)} found: ${esc(projectsLine(past.projects))}. They go to your private drafts, after the secrets the check recognises are redacted on this computer, so your agent can find what you already solved. A team gets only the ones you share with it.</span></span></label>`
                : ''
        }
        ${w.phase === 'teams' ? '<div class="card muted small"><span class="spinner"></span> Checking which of them ran in your teams’ repositories…</div>' : ''}
        ${w.phase === 'share' ? shareScreen() : ''}
        ${w.phase === 'done' && w.teamsError ? `<div class="alert warn">${icon('alert', 'sm')}<div class="grow">Could not check your teams: ${esc(w.teamsError)} Your sessions stay private meanwhile. <button class="link" data-action="retry-teams">Try again</button></div></div>` : ''}
        ${w.phase === 'done' && pastStarted(w) ? `<div class="alert ok">${icon('check', 'sm')}<div class="grow">Importing ${Number(w.done.past_import.total)} past session${w.done.past_import.total === 1 ? '' : 's'} to your private drafts in the background. Home shows how far it got.</div></div>` : ''}
        ${steps.length ? `<div class="alert warn">${icon('alert', 'sm')}<div class="grow"><strong>One more thing</strong><ul>${steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ul></div></div>` : ''}
        ${state.update.state === 'ready' ? `<div class="alert ok">${icon('download', 'sm')}<div class="grow">KeepPlain ${esc(state.update.version)} is ready. <button class="link" data-action="install-update">Restart to update</button></div></div>` : ''}
        <div class="welcome-actions">
            ${
                w.phase === 'share' || w.phase === 'teams'
                    ? ''
                    : w.phase === 'done' && (w.done?.installed?.length || connectedAgents().length)
                    ? '<button class="btn primary big" data-action="go" data-view="home">Open KeepPlain</button>'
                    : `<button class="btn primary big" data-action="get-started" ${busy || state.loading || !found.length ? 'disabled' : ''}>${busy ? '<span class="spinner"></span> Setting up…' : w.phase === 'done' || w.loginError || w.error ? 'Try again' : 'Get started'}</button>`
            }
        </div>
        <p class="foot">${icon('shield', 'sm')}<span>${setUp && w.past.asked ? 'Your past sessions go to your private drafts; a team gets only the ones you share with it.' : !setUp && importingPast() ? 'Only the past sessions above are sent, to your private drafts.' : 'Nothing is sent while setting up.'} <button class="link" data-action="open" data-url="${esc(state.status?.what_leaves ?? 'https://keepplain.com/plugins#what-leaves-your-machine')}">What leaves your computer</button></span></p>
    </div></div>`;
}

/* ---------- Home ---------- */

function viewHome() {
    const st = state.status;
    if (!st) return `<div class="page">${alertHtml('bad', state.statusError) || '<p class="muted"><span class="spinner"></span> Loading…</p>'}</div>`;
    const acc = state.account;
    const agents = connectedAgents();
    const user = st.account?.username ?? acc?.username;

    let banner;
    if (!st.signed_in || (acc && !acc.ok)) {
        banner = `<div class="banner warn"><span class="dot">${icon('alert', 'sm')}</span><div class="grow"><strong>${st.signed_in ? 'Your sign-in has expired' : 'You are not signed in'}</strong><div class="small muted">Sign in again to send sessions. It opens your browser.</div></div>
            <button class="btn primary" data-action="relogin" ${state.wizard.phase === 'login' ? 'disabled' : ''}>${state.wizard.phase === 'login' ? '<span class="spinner"></span> Waiting…' : 'Sign in'}</button></div>
            ${state.wizard.phase === 'login' && state.wizard.login ? `<div class="code-box under-banner">Check that your browser shows <strong>${esc(state.wizard.login.user_code)}</strong>, then press Connect. <button class="link" data-action="cancel-login">Cancel</button></div>` : ''}`;
    } else if (!agents.length) {
        banner = `<div class="banner warn"><span class="dot">${icon('alert', 'sm')}</span><div class="grow"><strong>No agent is connected</strong><div class="small muted">Switch one on below so KeepPlain can see its sessions.</div></div></div>`;
    } else {
        banner = `<div class="banner ok"><span class="dot">${icon('check', 'sm')}</span><div class="grow"><strong>All set: you can close this window</strong><div class="small muted">Connected to ${agents.map((a) => esc(a.name)).join(', ')}. ${closedNote(agents)}</div></div>
            <button class="btn primary" data-action="go" data-view="sessions">${icon('send', 'sm')} Send a session</button></div>`;
    }

    return `<div class="page">
        <div class="page-head"><h1>${user ? `Hi, @${esc(user)}` : 'Hi there'}</h1></div>
        ${banner}
        <div class="card-head"><p class="eyebrow">Your agents</p><span class="sub">Switch one on to let KeepPlain see its sessions.</span></div>
        <div class="agents">${st.agents.map(agentCard).join('')}</div>
        ${pastCard(st.past_import)}
        <p class="eyebrow">Last sent</p>
        ${lastSentCard(st.last_sent)}
        <p class="foot">${icon('shield', 'sm')}<span>${whatLeaves()}</span></p>
    </div>`;
}

/** What keeps working with the window closed: the agents' own plugin, which the app only sets up. */
function closedNote(agents) {
    return agents.some((a) => a.auto !== 'off')
        ? 'KeepPlain works inside them: your agents send sessions on their own.'
        : 'KeepPlain works inside them: send a session from your agent with its build command, or come back here to pick one.';
}

function whatLeaves() {
    const auto = connectedAgents().filter((a) => a.auto !== 'off');
    const text = auto.length
        ? `Sessions from ${auto.map((a) => esc(a.name)).join(', ')} are sent automatically, with secrets hidden first.`
        : 'Only sessions you choose leave this computer, with secrets hidden first.';

    return `${text} <button class="link" data-action="open" data-url="${esc(state.status?.what_leaves ?? 'https://keepplain.com/plugins#what-leaves-your-machine')}">What leaves your computer</button>`;
}

function agentCard(a) {
    const op = state.agentOp?.agent === a.id ? state.agentOp : null;
    const plugin = a.plugins.find((p) => p.source === 'local') ?? a.plugins[0];
    const busy = Boolean(state.agentOp && !state.agentOp.finished);
    const canSwitch = a.present && a.can_install && (a.managed || !a.connected) && !busy;
    // While it works, the switch stays where the person put it.
    const on = op && !op.finished ? op.target : a.connected;
    let line;
    if (!a.present) line = 'Not installed on this computer';
    else if (op && !op.finished) line = '<span class="spinner"></span> Working…';
    else if (a.connected) line = `${a.auto === 'off' ? 'Connected' : 'Connected · sends automatically'}${plugin?.source === 'directory' ? ' · from Claude’s plugin directory' : ''}`;
    else line = a.can_install ? 'Off' : 'Found, but it needs a manual step';
    const note = a.outdated ? 'An update is ready: switch it off and on to install it.' : (a.notes ?? [])[0];

    return `<div class="agent ${a.present ? '' : 'absent'}">
        <div class="row">${mark(a.id, a.present ? '' : 'off')}<div class="grow"><div class="name">${esc(a.name)}</div><div class="state">${line}</div></div>
            <label class="switch" title="${on ? 'Disconnect' : 'Connect'} ${esc(a.name)}"><input type="checkbox" aria-label="${esc(a.name)}" data-action="toggle-agent" data-agent="${esc(a.id)}" ${on ? 'checked' : ''} ${canSwitch ? '' : 'disabled'}><span></span></label></div>
        ${note && a.present ? `<div class="note">${esc(note)}</div>` : ''}
        ${op ? agentSteps(op.steps.filter((s) => s.status === 'failed')) + alertHtml('bad', op.error) + (op.todo.length ? alertHtml('warn', op.todo.join(' ')) : '') : ''}
    </div>`;
}

/** The import of past sessions while it goes (keepplain import-past): how far, why it waits, and Stop. */
function pastCard(p) {
    if (!p || !['running', 'login'].includes(p.status) || !p.left) return '';
    const done = Number(p.sent) + Number(p.skipped) + Number(p.failed);
    const why = p.status === 'login'
        ? p.why === 'login' ? 'Your sign-in was not accepted: sign in again and it goes on.' : 'It starts once you sign in.'
        : p.next_at
          ? `${p.why === 'daily_limit' ? 'Today’s share is in' : 'KeepPlain could not be reached'}; the rest go on ${esc(new Date(p.next_at).toLocaleString())} or later, when an agent session starts.`
          : p.active
            ? 'Oldest first, one every 15 seconds, while your agents work as usual.'
            : 'It goes on when an agent session starts.';
    const shared = Number(p.shared) ? `, ${Number(p.shared)} of them shared with a team` : '';

    return `<div class="card"><div class="row">${icon('download')}<div class="grow"><strong>Importing your past sessions: ${done} of ${Number(p.total)}</strong>
        <div class="small muted">${Number(p.sent)} imported${shared}. ${why}</div></div>
        <button class="btn" data-action="past-stop" ${state.pastBusy ? 'disabled' : ''}>Stop</button></div></div>`;
}

async function stopPast() {
    state.pastBusy = true;
    render();
    const r = await call('pastStop');
    state.pastBusy = false;
    if (!r.ok) toast(friendly(r.error), 'bad');
    await loadStatus({ quiet: true });
}

/**
 * While the import goes on, Home reads the status every so often; and when it waits for nothing with no runner at work
 * (after a restart), asking import-past starts it again.
 */
let pastTimer = null;
let pastNudged = false;
function watchPast() {
    const p = state.status?.past_import;
    const going = p && p.status === 'running' && p.left > 0;
    // Once a window: a runner that cannot start (no sign-in) is not asked again every few seconds.
    if (going && !p.active && !pastNudged && !(p.next_at && Date.parse(p.next_at) > Date.now())) {
        pastNudged = true;
        call('pastFound');
    }
    if (going && !pastTimer) {
        pastTimer = setInterval(() => {
            if (state.view === 'home' && document.visibilityState === 'visible') loadStatus({ quiet: true });
        }, 20_000);
    } else if (!going && pastTimer) {
        clearInterval(pastTimer);
        pastTimer = null;
    }
}

function lastSentCard(last) {
    if (!last) {
        return `<div class="card"><div class="row">${icon('inbox')}<div class="grow"><strong>Nothing sent yet</strong><div class="small muted">Your first session will show up here.</div></div>
            <button class="btn" data-action="go" data-view="sessions">Pick a session</button></div></div>`;
    }
    const where = last.space?.type === 'team' ? `the ${esc(last.space.name)} team` : last.space?.type === 'personal' ? 'your private drafts' : null;

    return `<div class="card"><div class="row">${mark(last.agent ?? 'claude-code')}<div class="grow"><strong>Last sent ${esc(ago(last.at))}</strong>
        <div class="small muted">${esc(agentName(last.agent ?? 'claude-code'))} session${where ? ` to ${where}` : ''}${last.how === 'auto' ? ', automatically' : last.how === 'past' ? ', imported from before KeepPlain' : ''}</div></div>
        ${last.url ? `<button class="btn" data-action="open" data-url="${esc(last.url)}">Open draft ${icon('out', 'sm')}</button>` : ''}</div></div>`;
}

async function toggleAgent(id, on) {
    const op = { agent: id, target: on, steps: [], error: null, todo: [], finished: false };
    state.agentOp = op;
    render();
    const r = await call('setAgent', { agent: id, on }, (e) => onAgentEvent(e, op.steps));
    const last = r.events.at(-1);
    if (!r.ok) op.error = friendly(r.error);
    op.todo = on ? todo(last) : [];
    op.finished = true;
    const worked = !op.error && !op.steps.some((s) => s.status === 'failed');
    if (worked) {
        // The switch lands at once: reading the status again takes the agents' own commands a second or more, and
        // until then the old status would put it back where it was.
        const agent = state.status?.agents.find((a) => a.id === id);
        if (agent) Object.assign(agent, { connected: on, managed: on, outdated: false, notes: [], plugins: on ? [{ id: 'keepplain@keepplain-local', version: state.status.version, source: 'local' }] : [] });
        toast(on ? `${agentName(id)} connected` : `${agentName(id)} disconnected`);
        if (!op.todo.length) state.agentOp = null;
    }
    render();
    await loadStatus({ quiet: true });
}

async function relogin() {
    const w = state.wizard;
    w.phase = 'login';
    w.login = null;
    render();
    const r = await call('login', {}, (e) => {
        if (e.event === 'opened') {
            w.login = e;
            render();
        }
    });
    w.phase = 'idle';
    if (r.ok) toast('Signed in');
    else if (!r.cancelled) toast(friendly(r.error), 'bad');
    await loadStatus({ quiet: true });
    await checkAccount();
}

/* ---------- Sessions ---------- */

function filteredSessions() {
    const s = state.sessions;
    const q = s.query.trim().toLowerCase();

    return (s.list ?? []).filter((x) => (s.agent === 'all' || x.agent === s.agent) && (!q || `${x.title ?? ''} ${x.first_prompt} ${x.project ?? ''}`.toLowerCase().includes(q)));
}

function viewSessions() {
    const s = state.sessions;
    const list = filteredSessions();
    const agentsHere = [...new Set((s.list ?? []).map((x) => x.agent))];
    const groups = [];
    for (const x of list) {
        const day = dayOf(x.last_active);
        if (groups.at(-1)?.day !== day) groups.push({ day, items: [] });
        groups.at(-1).items.push(x);
    }
    const folderName = s.folder?.split(/[\\/]/).filter(Boolean).at(-1);

    let body;
    if (s.error) body = alertHtml('bad', s.error);
    else if (s.loading && !s.list) body = `<div class="list">${'<div class="skeleton"></div>'.repeat(5)}</div>`;
    else if (!list.length) {
        body = `<div class="list"><div class="empty">${icon(s.query ? 'search' : 'inbox')}<div><strong>${s.query ? 'No sessions match' : 'No sessions yet'}</strong></div>
            <div class="small">${s.query ? 'Try other words.' : s.folder ? 'No Claude Code, Codex, Cursor or Pi sessions in this folder.' : 'Sessions from the last 30 days show up here once you work with a connected agent.'}</div></div></div>`;
    } else {
        body = groups.map((g) => `<p class="eyebrow group">${esc(g.day)}</p><div class="list">${g.items.map(sessionRow).join('')}</div>`).join('');
    }

    return `<div class="page">
        <div class="page-head"><h1>Sessions</h1><p class="sub">Your recent AI coding sessions. Pick one to send: you see what goes and who can see it before anything leaves.</p></div>
        <div class="toolbar">
            <div class="search">${icon('search', 'sm')}<input id="search" class="text" type="search" placeholder="Search sessions" value="${esc(s.query)}" data-action="search" autocomplete="off"></div>
            ${agentsHere.length > 1 ? `<div class="pills">${['all', ...agentsHere].map((a) => `<button class="${s.agent === a ? 'on' : ''}" data-action="filter-agent" data-agent="${esc(a)}">${a === 'all' ? 'All' : esc(agentName(a))}</button>`).join('')}</div>` : ''}
            <button class="btn ghost icon" title="Refresh" data-action="refresh-sessions" ${s.loading ? 'disabled' : ''}>${s.loading ? '<span class="spinner"></span>' : icon('refresh', 'sm')}</button>
        </div>
        <div class="folder-pill muted">${icon('folder', 'sm')}${s.folder ? `Only <strong>${esc(folderName)}</strong> <button class="link" data-action="all-folders">Show all projects</button>` : `All projects, last 30 days · <button class="link" data-action="choose-folder">Pick a folder</button>`}</div>
        ${body}
    </div>`;
}

function sessionRow(x) {
    const what = x.title || x.first_prompt || 'Untitled session';
    const project = x.project ?? state.sessions.folder?.split(/[\\/]/).filter(Boolean).at(-1);

    return `<div class="session">
        ${mark(x.agent, 'sm')}
        <div class="grow">
            <div class="what" title="${esc(what)}">${esc(what)}</div>
            <div class="meta">${project ? `<span>${esc(project)}</span><span class="sep"></span>` : ''}<span class="when">${esc(time(x.last_active))}</span><span class="sep"></span><span>${plural(x.prompts, 'prompt')}</span>
                ${x.sent_at ? `<span class="sep"></span>${x.draft_url ? `<button class="link" data-action="open" data-url="${esc(x.draft_url)}">Sent ${esc(ago(x.sent_at))}</button>` : `<span class="badge ok">Sent</span>`}` : ''}</div>
        </div>
        <button class="btn ${x.sent_at ? '' : 'primary'}" data-action="send-session" data-id="${esc(x.id)}" data-agent="${esc(x.agent)}">${x.sent_at ? 'Send again' : 'Send…'}</button>
    </div>`;
}

async function chooseFolder() {
    const r = await call('chooseFolder');
    if (!r) return;
    Object.assign(state.sessions, { folder: r.folder, list: null });
    loadSessions();
}

/* ---------- Confirmation ---------- */

async function openConfirm(id, agent) {
    const session = state.sessions.list?.find((s) => s.id === id && s.agent === agent);
    if (!session) return;
    state.confirm = { session, folder: session.folder ?? state.sessions.folder, preview: null, loading: true, error: null, sending: false, stage: null, progress: 0, done: null, sendError: null };
    state.view = 'confirm';
    render();
    await runPreview(null);
}

async function runPreview(space) {
    const c = state.confirm;
    c.loading = true;
    c.error = null;
    render();
    const r = await call('preview', { id: c.session.id, agent: c.session.agent, folder: c.folder, space });
    if (state.confirm !== c) return;
    c.loading = false;
    c.preview = r.ok ? r.result : null;
    c.error = r.ok ? null : friendly(r.error);
    render();
}

/** Leaving the confirmation without sending: what preview prepared goes now. */
async function leaveConfirm(view = 'sessions') {
    const c = state.confirm;
    state.confirm = null;
    state.view = view;
    render();
    if (c && !c.done && !c.sending) await call('discard', { id: c.session.id, agent: c.session.agent });
    if (c?.done) loadSessions({ quiet: true });
}

async function sendConfirmed() {
    const c = state.confirm;
    if (!c?.preview || c.sending || c.done || !c.preview.connected) return;
    Object.assign(c, { sending: true, sendError: null, stage: 'Sending the checked session…', progress: 15 });
    render();
    const r = await call('send', { id: c.session.id }, (e) => {
        if (e.event === 'created') Object.assign(c, { stage: 'Sent. KeepPlain is preparing your draft…', progress: 45, editUrl: e.edit_url, space: e.space });
        else if (e.event === 'stage') Object.assign(c, { stage: e.minutes ? `${e.label}… a long session takes about ${e.minutes} minutes` : `${e.label}…`, progress: Math.min(90, c.progress + 15) });
        else if (e.event === 'pending' || e.event === 'done') Object.assign(c, { progress: 100, result: e });
        render();
    });
    c.sending = false;
    if (r.ok) {
        c.done = { editUrl: c.editUrl, team: c.space?.type === 'team' ? c.space.name : null, pending: c.result?.event === 'pending' };
        loadStatus({ quiet: true });
    } else {
        c.sendError = friendly(r.error);
        // A send that never reached the site needs a fresh check before trying again.
        if (!c.editUrl) c.preview = null;
    }
    render();
}

function viewConfirm() {
    const c = state.confirm;
    const s = c.session;
    const p = c.preview;
    const what = s.title || s.first_prompt || 'Untitled session';
    const head = `<button class="back" data-action="cancel-confirm">${icon('back', 'sm')} Sessions</button>
        <h1>${esc(what)}</h1>
        <div class="metas">${mark(s.agent, 'sm')}<span>${esc(agentName(s.agent))}</span>${s.project ? `<span class="sep"></span><span>${esc(s.project)}</span>` : ''}${p ? `<span class="sep"></span><span>${plural(p.prompts, 'prompt')}</span><span class="sep"></span><span>${esc(p.duration)}</span>` : ''}</div>`;

    if (c.done) {
        return `<div class="page">${head}<div class="card success mt">
            <div class="big-check">${icon('check')}</div>
            <h1>Your draft is ready</h1>
            <p class="muted">${c.done.team ? `It is in the ${esc(c.done.team)} team’s drafts: only the team can see it.` : 'It is in your private drafts: only you can see it.'} Nothing is published until you do it on the site.</p>
            <div class="welcome-actions">${c.done.editUrl ? `<button class="btn primary big" data-action="open" data-url="${esc(c.done.editUrl)}">Review and publish ${icon('out', 'sm')}</button>` : ''}<button class="btn big" data-action="cancel-confirm">Back to sessions</button></div>
        </div></div>`;
    }
    if (c.loading && !p) {
        return `<div class="page">${head}<div class="card mt"><div class="check-head"><span class="spinner"></span><div><strong>Checking the session for secrets…</strong><div class="small muted">On this computer. Nothing has left yet.</div></div></div></div></div>`;
    }
    if (!p) {
        return `<div class="page">${head}<div class="mt">${alertHtml('bad', c.error ?? c.sendError)}</div>
            <div class="row"><button class="btn" data-action="cancel-confirm">Back</button><button class="btn primary" data-action="retry-preview">Check again</button></div></div>`;
    }

    const findings = p.privacy.findings;
    const teams = p.goes_to.teams;
    const current = p.goes_to.space === 'team' ? p.goes_to.team?.slug : 'personal';
    const team = p.goes_to.space === 'team' ? p.goes_to.team?.name : null;
    const locked = c.loading || c.sending;

    const audience = teams
        ? `<div class="choices">
            <button class="choice ${current === 'personal' ? 'on' : ''}" data-action="space" data-space="personal" ${locked ? 'disabled' : ''}>${icon('lock', 'sm')}<span><strong>Only me</strong><div class="small muted">Private draft</div></span></button>
            ${teams.map((t) => `<button class="choice ${current === t.slug ? 'on' : ''}" data-action="space" data-space="${esc(t.slug)}" ${locked ? 'disabled' : ''}>${icon('users', 'sm')}<span><strong>${esc(t.name)}</strong><div class="small muted">Team draft</div></span></button>`).join('')}
        </div>`
        : `<p>${esc(capital(p.goes_to.text))}.</p>`;

    return `<div class="page">
        ${head}
        <div class="gap"></div>
        <div class="card">
            <h2>Who can see it</h2>
            <p class="small muted">${team ? `Members of ${esc(team)} can see the draft. Nobody else.` : 'Only you can see the draft.'} It is not published until you publish it on the site.${p.draft_url ? ' You sent this session before: your draft is updated, not duplicated.' : ''}</p>
            ${audience}
            ${c.loading ? '<p class="small muted mt-s"><span class="spinner"></span> Updating…</p>' : ''}
        </div>

        <div class="card">
            <div class="check-head">
                <span class="check-icon ${findings.length ? 'warn' : 'ok'}">${icon(findings.length ? 'shield' : 'shieldCheck')}</span>
                <div class="grow"><h2>${findings.length ? `${plural(findings.length, 'possible secret')} found and hidden` : 'No secrets found'}</h2>
                <div class="small muted">${findings.length ? 'They are replaced on this computer. The real values never leave it.' : 'The check found no keys, tokens or email addresses.'}</div></div>
            </div>
            ${
                findings.length
                    ? `<ul class="findings">${findings.map((f) => `<li><span class="grow">${esc(capital(f.label))}${f.count > 1 ? ` <span class="faint small">· ${f.count} places</span>` : ''}</span><span class="badge ${f.kept ? 'warn' : 'ok'}">${f.kept ? 'Sent as is (your choice)' : `${icon('check', 'sm')} Hidden`}</span></li>`).join('')}</ul>`
                    : ''
            }
            <p class="small faint mt-s m0">The check catches common patterns, not everything. You read the draft before anyone else can. Names to always hide go in <button class="link" data-action="go" data-view="settings">Settings</button>.</p>
        </div>

        <div class="card">
            <details class="more"><summary>What’s included</summary>
                <dl class="facts">
                    <dt>Project</dt><dd>${esc(p.project ?? 'unknown')} <span class="faint">(name only, never the path)</span></dd>
                    ${p.folders.length ? `<dt>Added folders</dt><dd>${p.folders.map(esc).join(', ')}</dd>` : ''}
                    <dt>Conversation</dt><dd>${plural(p.prompts, 'prompt')}, ${plural(p.tool_calls, 'tool call')}, over ${esc(p.duration)}</dd>
                    <dt>Size</dt><dd>${esc(p.size.compressed)} (screenshots and long outputs left out)</dd>
                    ${p.git.map((g) => `<dt>Git</dt><dd>${esc(g)}</dd>`).join('')}
                    ${p.code ? `<dt>Code changes</dt><dd>${esc(p.code)}</dd>` : ''}
                    ${p.tokens ? `<dt>Tokens</dt><dd>${esc(p.tokens)}</dd>` : ''}
                    ${p.library ? `<dt>Library</dt><dd>${esc(p.library)}</dd>` : ''}
                    ${p.includes.length ? `<dt>Includes</dt><dd>${plural(p.includes.length, 'earlier session')} it continued</dd>` : ''}
                </dl>
            </details>
        </div>

        ${alertHtml('bad', c.sendError)}
        ${!p.connected ? alertHtml('warn', 'You are not signed in. Sign in from Home, then come back.') : ''}

        <div class="bar">
            ${
                c.sending
                    ? `<div class="grow"><div class="small"><span class="spinner"></span> ${esc(c.stage)}</div><progress class="progress" max="100" value="${c.progress}"></progress></div>`
                    : `<div class="grow small faint note">${icon('shield', 'sm')} Nothing has left your computer yet.</div>
                       <button class="btn" data-action="cancel-confirm">Cancel <span class="kbd">Esc</span></button>
                       <button class="btn primary big" data-action="confirm-send" ${c.loading || !p.connected ? 'disabled' : ''}>${icon('send', 'sm')} ${team ? `Send to ${esc(team)}` : 'Send to my drafts'}</button>`
            }
        </div>
    </div>`;
}

/* ---------- Settings ---------- */

function viewSettings() {
    const st = state.status;
    if (!st) return `<div class="page">${alertHtml('bad', state.statusError) || '<p class="muted"><span class="spinner"></span> Loading…</p>'}</div>`;
    const set = state.settings;
    const agents = connectedAgents();
    const modes = [...new Set(agents.map((a) => a.auto))];
    const mode = modes.length === 1 ? modes[0] : null;

    return `<div class="page">
        <div class="page-head"><h1>Settings</h1><p class="sub">These apply on this computer.</p></div>

        <div class="card">
            <h2>When to send sessions</h2>
            ${agents.length ? '' : '<p class="small muted">Connect an agent on Home first.</p>'}
            ${SEND_MODES.map(
                (c) => `<label class="option"><input type="radio" name="auto" value="${c.mode}" data-action="auto" ${mode === c.mode ? 'checked' : ''} ${!agents.length || set.busy ? 'disabled' : ''}>
                <span class="grow"><strong>${c.title}</strong> ${c.tag ? `<span class="badge accent">${c.tag}</span>` : ''}<div class="small muted">${c.text}</div></span></label>`,
            ).join('')}
            ${mode === 'push' ? '<p class="small muted mt-s">Right now: only when you push commits (set from the terminal).</p>' : ''}
            ${modes.length > 1 ? `<p class="small muted mt-s">Right now it differs per agent. Picking one applies it to all.</p>` : ''}
        </div>

        <div class="card">
            <h2>In your sessions</h2>
            <div class="setting mt-s"><div class="grow"><strong>Add my rules to new sessions</strong>
                <div class="small muted">Your agent starts with the coding rules you keep on KeepPlain for this kind of project. No code is sent to pick them.</div></div>
                <label class="switch"><input type="checkbox" aria-label="Add my rules" data-action="rules" ${st.rules ? 'checked' : ''} ${set.busy ? 'disabled' : ''}><span></span></label></div>
            <div class="setting"><div class="grow"><strong>Suggest sharing helpful sessions</strong>
                <div class="small muted">When a session used ideas from the library, your agent offers once to share it. It never sends anything itself.</div></div>
                <label class="switch"><input type="checkbox" aria-label="Suggest sharing" data-action="nudge" ${st.nudge ? 'checked' : ''} ${set.busy ? 'disabled' : ''}><span></span></label></div>
        </div>

        <div class="card">
            <h2>Always hide these words</h2>
            <p class="small muted">Client names, internal services, anything private. They’re replaced before a session leaves this computer.</p>
            ${st.privacy.error ? alertHtml('bad', st.privacy.error) : ''}
            <div class="words" data-action="focus-words">
                ${st.privacy.words.map((w) => `<span class="word">${esc(w)}<button title="Remove" aria-label="Remove ${esc(w)}" data-action="remove-word" data-word="${esc(w)}">×</button></span>`).join('')}
                <input id="word-input" data-action="word-input" placeholder="${st.privacy.words.length ? 'Add another…' : 'Type a word and press Enter'}" value="${esc(set.input)}" ${set.busy === 'words' ? 'disabled' : ''} autocomplete="off" spellcheck="false">
            </div>
        </div>

        <div class="card">
            <div class="setting"><div class="grow"><h2>KeepPlain ${esc(state.init?.app ?? '')}</h2>
                <div class="small muted">${esc(updateLine(state.update)) || 'Updates are checked when the app starts and every few hours, and install when you restart it.'}</div></div>
                ${
                    state.update.state === 'ready'
                        ? '<button class="btn primary" data-action="install-update">Restart to update</button>'
                        : `<button class="btn" data-action="check-updates" ${['off', 'store', 'checking', 'downloading'].includes(state.update.state) ? 'disabled' : ''}>${state.update.state === 'checking' ? '<span class="spinner"></span> Checking…' : 'Check for updates'}</button>`
                }</div>
            <p class="small faint mt-s m0">Command line ${esc(st.version)} · ${esc(siteHost())} · <button class="link" data-action="open" data-url="${esc(st.what_leaves)}">What leaves your computer</button></p>
        </div>

        <div class="card">
            <div class="setting"><div class="grow"><h2>Disconnect this computer</h2>
                <div class="small muted">Removes KeepPlain from your agents and signs out here. Your drafts stay on the site.</div></div>
                <button class="btn danger" data-action="disconnect" ${set.busy ? 'disabled' : ''}>${set.busy === 'disconnect' ? '<span class="spinner"></span> Disconnecting…' : 'Disconnect'}</button></div>
        </div>
    </div>`;
}

async function setting(name, work, done) {
    const set = state.settings;
    set.busy = name;
    render();
    const r = await work();
    set.busy = null;
    await loadStatus({ quiet: true });
    toast(r.ok ? done : friendly(r.error), r.ok ? '' : 'bad');

    return r;
}

function saveWords(words) {
    return setting('words', () => call('setWords', { words }), 'Saved');
}

async function disconnect() {
    const yes = await call('confirm', {
        message: 'Disconnect this computer from KeepPlain?',
        detail: 'KeepPlain is removed from your agents and you are signed out here. Your drafts and Builds stay on the site.',
        yes: 'Disconnect',
    });
    if (!yes) return;
    const r = await setting('disconnect', () => call('disconnect', {}, () => {}), 'Disconnected');
    if (r.ok) {
        state.wizard = { phase: 'idle', login: null, loginError: null, agents: [], error: null, done: null };
        state.account = null;
        state.view = 'welcome';
        render();
    }
}

/* ---------- frame ---------- */

/** The sidebar's word about an update: while it downloads, and the button to restart once it is ready. */
function updateBadge() {
    const u = state.update;
    if (u.state === 'downloading') return `<div class="update" title="Downloading update ${esc(u.version ?? '')}">${icon('download', 'sm')}<span>Downloading update… ${u.percent ?? 0}%</span></div>`;
    if (u.state !== 'ready') return '';

    return `<button class="update ready" data-action="install-update" title="Restart to update to ${esc(u.version)}">${icon('refresh', 'sm')}<span><strong>Update ready</strong>Restart to get ${esc(u.version)}</span></button>`;
}

function sidebar() {
    const tabs = [
        ['home', 'Home', 'home'],
        ['sessions', 'Sessions', 'list'],
        ['settings', 'Settings', 'gear'],
    ];
    const active = state.view === 'confirm' ? 'sessions' : state.view;
    const user = state.status?.account?.username;
    const expired = state.account && !state.account.ok;

    return `<aside class="side">
        ${brand(20)}
        <nav class="nav">${tabs.map(([v, label, ico]) => `<button class="${active === v ? 'on' : ''}" data-action="go" data-view="${v}" title="${label}">${icon(ico)}<span>${label}</span></button>`).join('')}</nav>
        ${updateBadge()}
        <div class="side-foot"><span class="avatar">${esc((user ?? '?').charAt(0).toUpperCase())}</span><div class="who"><div><strong>${user ? `@${esc(user)}` : 'Not signed in'}</strong></div>
            <div class="${expired ? 'warn-text' : 'faint host'}">${expired ? 'Sign-in expired' : esc(siteHost())}</div></div>
            ${state.loading ? '<span class="spinner"></span>' : ''}</div>
    </aside>`;
}

function render() {
    const root = document.getElementById('app');
    if (state.view === 'boot') return;
    // Keep the focus and the caret where the person was typing.
    const active = document.activeElement?.id;
    const caret = active ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null;
    const scroll = root.querySelector('.main')?.scrollTop ?? 0;
    const listScroll = root.querySelector('.share-list')?.scrollTop ?? 0;
    const views = { home: viewHome, sessions: viewSessions, confirm: viewConfirm, settings: viewSettings };
    const toasts = `<div class="toasts" role="status">${state.toasts.map((t) => `<div class="toast ${t.kind}">${icon(t.kind === 'bad' ? 'alert' : 'check', 'sm')}${esc(t.text)}</div>`).join('')}</div>`;
    root.innerHTML = state.view === 'welcome' ? viewWelcome() + toasts : `<div class="shell">${sidebar()}<main class="main">${views[state.view]()}</main></div>${toasts}`;
    const main = root.querySelector('.main');
    if (main) main.scrollTop = scroll;
    const list = root.querySelector('.share-list');
    if (list) list.scrollTop = listScroll;
    if (active) {
        const el = document.getElementById(active);
        if (el && !el.disabled) {
            el.focus();
            if (caret && el.setSelectionRange && caret[0] !== null) el.setSelectionRange(...caret);
        }
    }
}

/* ---------- events ---------- */

function go(view) {
    if (state.view === 'confirm' && view !== 'confirm') return leaveConfirm(view);
    state.view = view;
    render();
    document.querySelector('.main')?.scrollTo(0, 0);
    if (view === 'sessions' && !state.sessions.list) loadSessions();
    if (view === 'home' && state.status?.signed_in && !state.account) checkAccount();
}

document.addEventListener('click', async (event) => {
    const el = event.target.closest('[data-action]');
    if (!el || el.tagName === 'INPUT') return;
    const { action } = el.dataset;
    if (action === 'go') go(el.dataset.view);
    else if (action === 'open') call('open', { url: el.dataset.url });
    else if (action === 'get-started') getStarted();
    else if (action === 'cancel-login') call('cancelLogin');
    else if (action === 'relogin') relogin();
    else if (action === 'choose-folder') chooseFolder();
    else if (action === 'all-folders') {
        Object.assign(state.sessions, { folder: null, list: null });
        loadSessions();
    } else if (action === 'refresh-sessions') loadSessions();
    else if (action === 'filter-agent') {
        state.sessions.agent = el.dataset.agent;
        render();
    } else if (action === 'send-session') openConfirm(el.dataset.id, el.dataset.agent);
    else if (action === 'cancel-confirm') leaveConfirm('sessions');
    else if (action === 'retry-preview') runPreview(null);
    else if (action === 'space') runPreview(el.dataset.space);
    else if (action === 'confirm-send') sendConfirmed();
    else if (action === 'remove-word') saveWords(state.status.privacy.words.filter((w) => w !== el.dataset.word));
    else if (action === 'focus-words') document.getElementById('word-input')?.focus();
    else if (action === 'disconnect') disconnect();
    else if (action === 'check-updates') checkUpdates();
    else if (action === 'install-update') call('installUpdate');
    else if (action === 'past-stop') stopPast();
    else if (action === 'share-team') answerTeam(true);
    else if (action === 'retry-teams') offerTeams();
    else if (action === 'keep-private') answerTeam(false);
});

document.addEventListener('change', (event) => {
    const el = event.target;
    const { action } = el.dataset ?? {};
    if (action === 'toggle-agent') toggleAgent(el.dataset.agent, el.checked);
    else if (action === 'past-tick') {
        state.wizard.past.on = el.checked;
        state.wizard.past.touched = true;
        render();
    } else if (action === 'share-one' || action === 'share-all') {
        const s = state.wizard.share;
        const offer = s.offers[s.index];
        if (action === 'share-all') s.chosen = new Set(el.checked ? offer.sessions.map((x) => x.id) : []);
        else if (el.checked) s.chosen.add(el.dataset.id);
        else s.chosen.delete(el.dataset.id);
        render();
    }
    else if (action === 'auto') setting('auto', () => call('setAuto', { mode: el.value, agents: connectedAgents().map((a) => a.id) }), 'Saved');
    else if (action === 'rules') setting('rules', () => call('setRules', { on: el.checked }), el.checked ? 'Rules on' : 'Rules off');
    else if (action === 'nudge') setting('nudge', () => call('setNudge', { on: el.checked }), 'Saved');
});

document.addEventListener('input', (event) => {
    const { action } = event.target.dataset ?? {};
    if (action === 'search') {
        state.sessions.query = event.target.value;
        render();
    } else if (action === 'word-input') state.settings.input = event.target.value;
});

document.addEventListener('keydown', (event) => {
    const el = event.target;
    if (el.dataset?.action === 'word-input') {
        const word = el.value.replace(/,$/, '').trim();
        if ((event.key === 'Enter' || event.key === ',') && word) {
            event.preventDefault();
            state.settings.input = '';
            if (!state.status.privacy.words.includes(word)) saveWords([...state.status.privacy.words, word]);
            else render();
        } else if (event.key === 'Backspace' && !el.value && state.status.privacy.words.length) {
            saveWords(state.status.privacy.words.slice(0, -1));
        }
        return;
    }
    if (state.view === 'confirm') {
        if (event.key === 'Escape' && !state.confirm?.sending) leaveConfirm('sessions');
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) sendConfirmed();
    }
});

// Back to the window after a while: what changed meanwhile (an agent's session, a send by auto mode) shows up.
window.addEventListener('focus', () => {
    if (state.view === 'boot' || state.view === 'welcome' || Date.now() - state.loadedAt < REFRESH_ON_FOCUS_MS) return;
    loadStatus({ quiet: true });
    if (state.view === 'sessions') loadSessions({ quiet: true });
});

boot();
