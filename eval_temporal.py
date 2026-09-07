"""时序叶片对应评估 CLI。实现见 eval_leaf_tracks.py，公式与论文表述见 时序评估指标.md。

用法：
  python eval_temporal.py --gt E:\\pepper_results\\K10 --pred E:\\pepper_results\\K10-WR
"""

from eval_leaf_tracks import main

if __name__ == "__main__":
    main()
